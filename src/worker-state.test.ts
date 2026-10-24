// no-token: gh -- no `gh`, `git` or `herdr` is run; the rows, pull requests, listing and clock are fixtures, the rows `blocked` writes are the fake code host's, and the only files written are in temporary directories (a11ign/agent-org#460)
// #460: A WORKER'S TURN ENDS WITH A DECLARED STATE, AND AN IDLE WORKER WITHOUT A FRESH ONE IS STALLED.
//
// `agent-org worker:state <state>` is the one command; the gate reads what it wrote with no model. Four things are shown here, each beside its twin:
//   1. the command: four states accepted with their arguments, every malformed call refused BY NAME with nothing written;
//   2. the excuse: an idle worker with a fresh declaration whose condition still holds is NOT nudged, and the same declaration once the condition has
//      gone (the checks finished, the pull request merged, the label removed) IS, as is no declaration and one older than the worker's last turn;
//   3. `blocked` APPLIES the label itself, and the excuse ends when the label comes off;
//   4. a session herdr reports `blocked` is told to declare or decide ONCE per stall, and a second tick sends nothing.
// A "not nudged" with no nudged twin proves nothing, so every one has a twin; the mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { claimStallTick } from "./work-gate/claim-stall-tick.ts";
import { claimRecordComment } from "./row-claim.ts";
import { ANSWER_PREFIX, SESSION_PREFIX } from "./project-vocabulary.ts";
import { COMMANDS } from "./commands.ts";
import { STOPPED_CLAIMANT_MINUTES, VERIFIED_CLOSE_MINUTES, verifiedCloseOrder } from "./idle-claimant.ts";
import { readClaim, type ClaimFacts } from "./claim-stall/stall-causes-and-claim-readings.ts";
import { TRACKER } from "./ticket-port/github-adapter.ts";
import type { BlockerWriter, ItemRef } from "./ticket-port/port.ts";
import {
  BLOCKED_TOLD_FILE, DECLARED_STATES, DEFAULT_ANSWERER, WORKER_STATE_DIR, applyBlocked, blockedInstruction, blockedToTell, declarationReading,
  closingComment, ghRowLook, lastDeliveredTo, main, parseDeclaration, parseMet, readDeclarations, resolveBlockedRow, resolveDone, rulingOn, splitArgs, tellBlocked, writeDeclaration, type ClaimContext,
  type Declaration, type RowComment, type RowFact, type RowLook, type DoneWhenReading, type DeclarationReading,
} from "./worker-state.ts";
import { MANAGER_SEATS } from "./decided-by.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

/** What `blocked` writes goes to the code host, whose fake acts on its own state: the executor handed to `applyBlocked` is never run. */
const NO_RUN = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};

/** One operation `applyBlocked` asked of the code host, without the executor it was handed. */
type Asked = { op: string; [field: string]: unknown };

/**
 * The fake code host, installed, whose own repository is `repo` and which holds the open rows `rows` (number to the labels it carries), and the writes `blocked` asks of it, in order. `asked` records an
 * operation when it is CALLED, so a write the code host refused is recorded too.
 */
function writableHost(repo: string, rows: Record<number, string[]> = { 12: [], 460: [] }) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = repo;
  for (const [number, labels] of Object.entries(rows)) world.rows.set(Number(number), fakeRow(world, Number(number), { labels }));
  const asked: Asked[] = [];
  const operations = host.rows as unknown as Record<string, (request: { run?: unknown }) => unknown>;
  for (const op of ["ensureTriageLabel", "addLabelToRowIn", "commentOnIssue"]) {
    const real = operations[op];
    operations[op] = ({ run: _run, ...request }) => { asked.push({ op, ...request }); return real({ ...request, run: NO_RUN }); };
  }
  substituteCodeHost(host);
  return { world, asked };
}
const opsOf = (asked: Asked[]): string[] => asked.map(({ op }) => op);

const MIN = 60_000;
const T0 = Date.parse("2026-10-10T09:00:00Z");
const M = STOPPED_CLAIMANT_MINUTES;
const STANDING = [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }];
const scratch = (prefix: string): string => mkdtempSync(join(tmpdir(), `worker-state-${prefix}-`));

// --- 1. the command ------------------------------------------------------------------------------------------------------

const parse = (...words: string[]) => parseDeclaration(words, { session: "worker-9", now: T0 });
const refusalOf = (...words: string[]): string | undefined => {
  const parsed = parse(...words);
  return "refused" in parsed ? parsed.refused.refused : undefined;
};

test("the four states are exactly waiting-ci, waiting-review, done and blocked", () => {
  assert.deepEqual([...DECLARED_STATES], ["waiting-ci", "waiting-review", "done", "blocked"]);
});

test("all four states are ACCEPTED with their arguments, and carry the session and the time", () => {
  assert.deepEqual(parse("waiting-ci", "123"), { declaration: { session: "worker-9", state: "waiting-ci", at: T0, pr: { number: 123 } } });
  assert.deepEqual(parse("waiting-review", "#124"), { declaration: { session: "worker-9", state: "waiting-review", at: T0, pr: { number: 124 } } });
  assert.deepEqual(parse("waiting-ci", "other-repo#7"), { declaration: { session: "worker-9", state: "waiting-ci", at: T0, pr: { number: 7, repoKey: "other-repo" } } });
  assert.deepEqual(parse("done"), { declaration: { session: "worker-9", state: "done", at: T0 } });
  assert.deepEqual(parse("blocked", "460", "which", "label", "is", "it?"), {
    declaration: { session: "worker-9", state: "blocked", at: T0, row: 460, reason: "which label is it?", to: DEFAULT_ANSWERER },
  });
  assert.deepEqual(parseDeclaration(["blocked", "#460", "why"], { session: "worker-9", now: T0, to: "ceo" }),
    { declaration: { session: "worker-9", state: "blocked", at: T0, row: 460, reason: "why", to: "ceo" } }, "--to names who owes the answer");
});

test("each malformed call is REFUSED BY NAME (twin: the well-formed call beside it is accepted)", () => {
  assert.equal(refusalOf(), "no-state");
  assert.equal(refusalOf("finished"), "unknown-state");
  assert.equal(refusalOf("waiting-ci"), "missing-pr");
  assert.equal(refusalOf("waiting-review"), "missing-pr");
  assert.equal(refusalOf("waiting-ci", "soon"), "bad-pr");
  assert.equal(refusalOf("waiting-ci", "0"), "bad-pr");
  assert.equal(refusalOf("waiting-ci", "12", "13"), "unexpected-argument");
  assert.equal(refusalOf("done", "12"), "missing-met", "`done <row>` with no reading is not a close (agent-org#1536)");
  assert.equal(refusalOf("done", "12", "13"), "unexpected-argument", "`done` takes one row: a stray argument is not silently dropped");
  assert.equal(refusalOf("blocked"), "missing-row");
  assert.equal(refusalOf("blocked", "row-one", "why"), "bad-row");
  assert.equal(refusalOf("blocked", "460"), "missing-reason");
  assert.equal(refusalOf("blocked", "460", "   "), "missing-reason");
  assert.equal(parseDeclaration(["done"], { session: null, now: T0 }).hasOwnProperty("refused"), true, "no session to declare as");
  assert.equal((parseDeclaration(["done"], { session: null, now: T0 }) as { refused: { refused: string } }).refused.refused, "no-session");
  assert.equal(refusalOf("done"), undefined);
  assert.equal(refusalOf("waiting-ci", "123"), undefined);
  assert.equal(refusalOf("blocked", "460", "a reason"), undefined);
  const named = parse("blocked", "460") as { refused: { why: string } };
  assert.match(named.refused.why, /needs the reason/, "and the words say what is missing, then the usage");
  assert.match(named.refused.why, /usage: agent-org worker:state/);
});

test("the flags are `--session`, `--to` and `--on` and nothing else (twin: both spellings of a value)", () => {
  assert.deepEqual(splitArgs(["blocked", "460", "why", "--session=worker-9", "--to", "ceo"]), { words: ["blocked", "460", "why"], flags: { session: "worker-9", to: "ceo" }, unknown: [] });
  assert.deepEqual(splitArgs(["blocked", "12", "why", "--on=7"]), { words: ["blocked", "12", "why"], flags: { on: "7" }, unknown: [] });
  assert.deepEqual(splitArgs(["blocked", "12", "why", "--on", "agent-org#7"]), { words: ["blocked", "12", "why"], flags: { on: "agent-org#7" }, unknown: [] });
  assert.deepEqual(splitArgs(["done", "--force"]).unknown, ["--force"]);
  assert.deepEqual(splitArgs(["done", "--session"]).unknown, ["--session"], "a flag with no value is refused, not read as empty");
  assert.deepEqual(splitArgs(["blocked", "12", "why", "--on"]).unknown, ["--on"], "`--on` with no value is refused too");
});

test("`--on` is `blocked` only, is read as a row, owes no answer so carries no `to`, and cannot come with `--to` (twin: without it, the same call is as before)", () => {
  const onParse = (words: string[], on: string | null, to: string | null = null) => parseDeclaration(words, { session: "worker-9", now: T0, on, to });
  const edge = onParse(["blocked", "12", "waiting", "on", "a", "decision"], "7");
  assert.deepEqual(edge, { declaration: { session: "worker-9", state: "blocked", at: T0, row: 12, reason: "waiting on a decision", on: 7 } });
  assert.equal("to" in (edge as { declaration: object }).declaration, false, "no `to`: there is no answer to be owed");
  assert.deepEqual((onParse(["blocked", "agent-org#12", "why"], "agent-org#7") as { declaration: object }).declaration,
    { session: "worker-9", state: "blocked", at: T0, row: 12, rowKey: "agent-org", reason: "why", on: 7, onKey: "agent-org" }, "both rows keep the spelling the file needs to resolve them");
  assert.deepEqual(onParse(["blocked", "460", "why"], null), parse("blocked", "460", "why"), "no `--on`: byte-identical to the declaration it was before");
  assert.equal((onParse(["blocked", "12", "why"], "7", "ceo") as { refused: { refused: string } }).refused.refused, "unexpected-argument", "--on and --to say two things about one wait");
  assert.equal((onParse(["done"], "7") as { refused: { refused: string } }).refused.refused, "unexpected-argument", "`done` names no row it waits on");
  assert.equal((onParse(["waiting-ci", "9"], "7") as { refused: { refused: string } }).refused.refused, "unexpected-argument", "a pull request is not a row it waits on");
  assert.equal((onParse(["blocked", "12", "why"], "abc") as { refused: { refused: string } }).refused.refused, "bad-on", "a malformed `--on` is refused by name");
  assert.equal((onParse(["blocked", "12", "why"], "0") as { refused: { refused: string } }).refused.refused, "bad-on");
});

/** Runs the real `main` with stderr captured; the refusals return before the host's state directory is touched. */
async function runMain(argv: string[]): Promise<{ code: number; stderr: string }> {
  const real = process.stderr.write.bind(process.stderr);
  let stderr = "";
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => { stderr += String(chunk); return true; };
  try {
    return { code: await main(argv, {}, T0), stderr };
  } finally {
    (process.stderr as { write: unknown }).write = real;
  }
}

test("the command exits 1 and names the refusal on stderr: an unknown state, a missing pull request, `blocked` with no reason, an unknown flag", async () => {
  for (const [argv, name] of [
    [["finished", "--session=worker-9"], "unknown-state"],
    [["waiting-ci", "--session=worker-9"], "missing-pr"],
    [["blocked", "460", "--session=worker-9"], "missing-reason"],
    [["done", "--session=worker-9", "--frobnicate"], "unknown-flag"],
  ] as [string[], string][]) {
    const ran = await runMain(argv);
    assert.equal(ran.code, 1, argv.join(" "));
    assert.match(ran.stderr, new RegExp(`^REFUSED ${name}:`), argv.join(" "));
  }
});

test("the command is registered as `worker:state` and its file leads with the header the command table is checked against", () => {
  assert.equal((COMMANDS as Record<string, string>)["worker:state"], "worker-state.ts");
  const head = readFileSync(new URL("./worker-state.ts", import.meta.url), "utf8").split("\n").slice(0, 4).join("\n");
  assert.match(head, /^\/\/ command: worker:state -- /m);
});

// --- the store -----------------------------------------------------------------------------------------------------------

test("a declaration written is the declaration read back, one file per session; an absent directory is `nobody declared`, an unreadable one is `could not ask`", () => {
  const dir = scratch("store");
  try {
    const state = `${dir}/${WORKER_STATE_DIR}`;
    assert.deepEqual(readDeclarations(state), { byClaimant: new Map(), unreadable: [] }, "no worker has declared: a fact");
    const mine: Declaration = { session: "worker-9", state: "waiting-ci", at: T0, pr: { number: 9001 } };
    writeDeclaration(state, mine);
    writeDeclaration(state, { session: "worker-8", state: "done", at: T0 });
    assert.deepEqual(readDeclarations(state)?.byClaimant.get("worker-9"), mine);
    assert.deepEqual(readdirSync(state).sort(), ["worker-8.json", "worker-9.json"], "no temp file is left behind");
    writeDeclaration(state, { ...mine, state: "waiting-review", at: T0 + MIN });
    assert.equal(readDeclarations(state)?.byClaimant.get("worker-9")?.state, "waiting-review", "the newest declaration of a session replaces its last");
    writeFileSync(`${state}/worker-7.json`, "{not json");
    const withCorrupt = readDeclarations(state);
    assert.deepEqual(withCorrupt?.unreadable, ["worker-7.json"], "one corrupt file is named and skipped, never the whole directory");
    assert.equal(withCorrupt?.byClaimant.size, 2);
    writeFileSync(`${dir}/not-a-directory`, "x");
    assert.equal(readDeclarations(`${dir}/not-a-directory`), null, "a path that cannot be listed is `could not ask`, not `none`");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the reading, pure ---------------------------------------------------------------------------------------------------

const ctx = (over: Partial<ClaimContext> = {}): ClaimContext => ({ row: 460, claimedAt: T0 - 60 * MIN, turnStartedAt: null, ownPrs: [], mergedPr: null, answersOwed: [], ...over });
const decl = (over: Partial<Declaration>): Declaration => ({ session: "worker-9", state: "waiting-ci", at: T0 - 5 * MIN, pr: { number: 9001 }, ...over });

test("a declaration is FRESH while newer than the turn began: the last delivery to the session, else the claim (twin: the older one is stale)", () => {
  const open = ctx({ ownPrs: [{ number: 9001, checksPending: true }] });
  assert.equal(declarationReading(decl({}), open).kind, "excused");
  const delivered = ctx({ ...open, turnStartedAt: T0 - 2 * MIN });
  const stale = declarationReading(decl({ at: T0 - 5 * MIN }), delivered);
  assert.equal(stale.kind, "stale", "a prompt arrived after the declaration: it belongs to a turn that ended before it");
  assert.equal(declarationReading(decl({ at: T0 - MIN }), delivered).kind, "excused", "the control: declared after the prompt");
  assert.equal(declarationReading(decl({ at: T0 - 90 * MIN }), open).kind, "stale", "and one older than the claim is another claim's");
  assert.equal(declarationReading(undefined, open).kind, "none");
});

test("each state is excused ONLY while the thing it names is true (twin: the same declaration once it is not)", () => {
  const pending = { number: 9001, checksPending: true, reviewDecision: "REVIEW_REQUIRED" };
  assert.equal(declarationReading(decl({}), ctx({ ownPrs: [pending] })).kind, "excused", "waiting-ci: a check is running");
  assert.equal(declarationReading(decl({}), ctx({ ownPrs: [{ ...pending, checksPending: false }] })).kind, "lapsed", "waiting-ci: the checks finished");
  assert.equal(declarationReading(decl({}), ctx({ ownPrs: [], mergedPr: { number: 9001 } })).kind, "lapsed", "waiting-ci: the pull request merged");
  assert.equal(declarationReading(decl({}), ctx({ ownPrs: [{ ...pending, number: 9002 }] })).kind, "lapsed", "waiting-ci: it is ANOTHER pull request that is open");
  assert.equal(declarationReading(decl({ state: "waiting-review" }), ctx({ ownPrs: [{ ...pending, checksPending: false }] })).kind, "excused", "waiting-review: open, review asked");
  assert.equal(declarationReading(decl({ state: "waiting-review" }), ctx({ ownPrs: [{ ...pending, reviewDecision: "CHANGES_REQUESTED" }] })).kind, "lapsed", "waiting-review: changes requested");
  assert.equal(declarationReading(decl({ state: "waiting-review" }), ctx({ ownPrs: [], mergedPr: { number: 9001 } })).kind, "lapsed", "waiting-review: merged");
  assert.equal(declarationReading(decl({ state: "done", pr: undefined }), ctx({ mergedPr: { number: 9001 } })).kind, "excused", "done: the pull request merged");
  assert.equal(declarationReading(decl({ state: "done", pr: undefined }), ctx({ rowClosed: true })).kind, "excused", "done: the row is closed");
  assert.equal(declarationReading(decl({ state: "done", pr: undefined }), ctx({})).kind, "lapsed", "done: the row is open and nothing merged");
  const blocked = decl({ state: "blocked", pr: undefined, row: 460 });
  assert.equal(declarationReading(blocked, ctx({ answersOwed: [DEFAULT_ANSWERER] })).kind, "excused", "blocked: the row carries the answer label");
  assert.equal(declarationReading(blocked, ctx({ answersOwed: [] })).kind, "lapsed", "blocked: the label came off");
  assert.equal(declarationReading({ ...blocked, row: 461 }, ctx({ answersOwed: [DEFAULT_ANSWERER] })).kind, "lapsed", "blocked: on a row the worker does not hold");
});

test("`blocked` is excused by the label of the session it NAMES, and an answer label owed by anyone else does not excuse it (twin: the named one does)", () => {
  const toCeo = decl({ state: "blocked", pr: undefined, row: 460, to: "ceo" });
  assert.equal(declarationReading(toCeo, ctx({ answersOwed: ["ceo"] })).kind, "excused", "--to=ceo and the row carries ceo's label");
  assert.equal(declarationReading(toCeo, ctx({ answersOwed: [DEFAULT_ANSWERER] })).kind, "lapsed", "--to=ceo, and only product-manager's label is on the row");
  assert.equal(declarationReading(toCeo, ctx({ answersOwed: [DEFAULT_ANSWERER, "ceo"] })).kind, "excused", "both labels: the named one is there");
  const unnamed = decl({ state: "blocked", pr: undefined, row: 460 });
  assert.equal(declarationReading(unnamed, ctx({ answersOwed: ["ceo"] })).kind, "lapsed", "no --to means product-manager, so ceo's label is another wait");
  const reading = declarationReading(toCeo, ctx({ answersOwed: [DEFAULT_ANSWERER] }));
  assert.ok(reading.kind === "lapsed" && reading.why.includes("ceo") && reading.why.includes(DEFAULT_ANSWERER), "the order names who it was declared on and what the row carries");
});

test("`--to` naming the worker itself is REFUSED by name: its own answer label is the row waiting on it, which could never excuse the block", () => {
  const refused = parseDeclaration(["blocked", "460", "why"], { session: "worker-9", now: T0, to: "worker-9" });
  assert.ok("refused" in refused && refused.refused.refused === "owed-to-self", JSON.stringify(refused));
});

test("`lastDeliveredTo` reads deliveries TO the session from the wake ledger, and not markers or other sessions' lines", () => {
  const ledger = [
    `${T0 - 50 * MIN}\tworker-9/claim-stalled/row-460/nudge-1`,
    `${T0 - 40 * MIN}\treviewer-12/review/pr-9\tworker-9`,
    `${T0 - 30 * MIN}\tworker-8/claim-stalled/row-461/nudge-2`,
    `${T0 - 20 * MIN}\tRESET`,
    `${T0 - 10 * MIN}\tVOIDED\tworker-9`,
    "not a line",
  ].join("\n");
  assert.equal(lastDeliveredTo(ledger, "worker-9"), T0 - 40 * MIN, "the recipient field counts, a RESET and a VOIDED do not, and another session's line does not");
  assert.equal(lastDeliveredTo(ledger, "worker-8"), T0 - 30 * MIN);
  assert.equal(lastDeliveredTo(ledger, "worker-1"), null);
  assert.equal(lastDeliveredTo("", "worker-9"), null);
});

// --- 2. the gate: the excuse, with no model -------------------------------------------------------------------------------

const noGit = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };
const claimed = (row: number, session: string) => ({ number: row, comments: [{
  body: claimRecordComment({ session, branch: `agent/x-${row}`, worktree: `../wt-${row}` }),
  createdAt: new Date(T0 - 20 * MIN).toISOString(), author: { login: "a11ign-ai-workers" } }] });
const rowOf = (number: number, session: string, labels: string[] = []) => ({ number, title: `row ${number}`, body: "", blockedBy: { nodes: [] },
  labels: ["in-progress", `session:${session}`, ...labels].map((name) => ({ name })) });
const prOf = (row: number, { pending = false } = {}) => ({ number: 9000 + row, headRefName: `agent/x-${row}`, reviewDecision: "REVIEW_REQUIRED", labels: [],
  statusCheckRollup: [pending
    ? { name: "gate", status: "IN_PROGRESS", startedAt: "2026-10-10T08:50:00Z", completedAt: "0001-01-01T00:00:00Z" }
    : { name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-10T08:50:00Z", completedAt: "2026-10-10T08:55:00Z" }] });

type Order = { session: string; cause: string; causeKey: string; prompt: string; release?: { why: string } };
type World = { row?: ReturnType<typeof rowOf>; prs?: object[]; merged?: object[] | null; status?: string; stateDir: string; ledger?: string; log?: string[] };

/** One tick at `minutes` after T0, with the nudge memory surviving between calls as the state file does; releases are filtered out, a release is not a nudge. */
function tickAt(minutes: number, w: World, memory: Record<string, unknown>): Order[] {
  const orders = claimStallTick({ rows: [w.row ?? rowOf(460, "worker-9")], claimedComments: [claimed(460, "worker-9")], openPrs: w.prs ?? [], mergedPrs: w.merged ?? null,
    io: noGit, repo: "/repo", now: T0 + minutes * MIN, restartAt: null, agents: [...STANDING, { label: "worker-9", status: w.status ?? "idle" }], stateDir: w.stateDir,
    ledger: () => w.ledger ?? "", log: (line: string) => w.log?.push(line),
    read: () => JSON.parse(JSON.stringify(memory)), write: (_path: string, state: object) => { for (const k of Object.keys(memory)) delete memory[k]; Object.assign(memory, state); },
  } as never) as unknown as Order[];
  return orders.filter((o) => o.release === undefined);
}
/** The minutes, one per tick a minute apart from 0 to `until`, at which this world nudges. */
function nudgedAt(w: World, until = 60): number[] {
  const memory: Record<string, unknown> = {};
  const at: number[] = [];
  for (let m = 0; m <= until; m++) if (tickAt(m, w, memory).length > 0) at.push(m);
  return at;
}
/** A state directory in which `worker-9` declared `declaration` `minutesBefore` T0. The claim is 20 minutes old, so 5 is fresh and 30 predates the claim. */
function declared(declaration: Omit<Declaration, "session" | "at">, minutesBefore = 5): string {
  const dir = scratch("declared");
  writeDeclaration(`${dir}/${WORKER_STATE_DIR}`, { session: "worker-9", at: T0 - minutesBefore * MIN, ...declaration });
  return dir;
}
const cleanup: string[] = [];
const dirOf = (declaration: Omit<Declaration, "session" | "at"> | null, minutesBefore = 5): string => {
  const dir = declaration === null ? scratch("none") : declared(declaration, minutesBefore);
  cleanup.push(dir);
  return dir;
};
after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });

test("NEGATIVE CONTROL: an idle worker with a fresh `waiting-ci` for an open PR is NOT nudged; with the PR gone it IS", () => {
  const waiting = dirOf({ state: "waiting-ci", pr: { number: 9460 } });
  assert.deepEqual(nudgedAt({ prs: [prOf(460, { pending: true })], stateDir: waiting }), [], "declared, open, a check running: the wait the worker named");
  assert.equal(nudgedAt({ prs: [], stateDir: waiting })[0], M, "the same declaration once the pull request is no longer open: stalled, and told within the figure");
  assert.deepEqual(nudgedAt({ prs: [prOf(460)], stateDir: waiting }), [], "agent-org#805: and once the checks have finished, an open pull request is still never a nudge");
  // MERGED is `mergedReading`'s before it is the idle reading's (#2470): a holder whose pull request merged and whose tree is clean is RELEASED, which is a
  // stronger reply than a nudge, and the declaration does not stand between the gate and it. (`declarationReading` calls this declaration `lapsed`, above.)
  const merged = { number: 9460, headRefName: "agent/x-460", mergedAt: "2026-10-10T08:58:00Z" };
  const memory = { 460: { session: "worker-9", idleSince: T0 } };
  const onMerge = claimStallTick({ rows: [rowOf(460, "worker-9")], claimedComments: [claimed(460, "worker-9")], openPrs: [], mergedPrs: [merged], io: noGit, repo: "/repo",
    now: T0 + M * MIN, restartAt: null, agents: [...STANDING, { label: "worker-9", status: "idle" }], stateDir: waiting, ledger: () => "", log: () => undefined,
    read: () => memory, write: () => undefined } as never) as unknown as Order[];
  assert.deepEqual(onMerge.map((o) => o.release?.why), ["merged"], "the declared PR merged: the worker is not left idle on a declaration that stopped being true");
});

test("an idle worker with NO declaration is nudged at #458's figure (M), not at the 45-minute clock; a `done` herdr status is as idle as `idle`", () => {
  const none = dirOf(null);
  assert.equal(nudgedAt({ stateDir: none })[0], M, "no PR, no declaration");
  assert.deepEqual(nudgedAt({ prs: [prOf(460, { pending: true })], stateDir: none }), [], "agent-org#805: an open PR with a pending check is never a nudge, declared or not");
  assert.equal(nudgedAt({ stateDir: none, status: "done" })[0], M);
  assert.deepEqual(nudgedAt({ stateDir: none, status: "working" }), [], "twin: a working worker is not idle");
  const [order] = tickAt(M, { stateDir: none }, { 460: { session: "worker-9", idleSince: T0 } });
  assert.equal(order.cause, "claim-stalled", "its ledger line is #458's `claimed-worker-stalled`, which the cause drives");
  assert.match(order.prompt, /YOU DECLARED NOTHING/);
  assert.match(order.prompt, /agent-org worker:state waiting-ci <pr>/);
  assert.match(order.prompt, /agent-org worker:state blocked <row> <reason>/);
});

test("a declaration older than the worker's last turn, or made before its claim, is no excuse only for a CLOSED pull request (agent-org#805: an open one is never a nudge); with the PR closed the declaration lapses and the worker is nudged at M", () => {
  const waiting = { state: "waiting-ci" as const, pr: { number: 9460 } };
  const world = (dir: string, ledger = ""): World => ({ prs: [prOf(460, { pending: true })], stateDir: dir, ledger });
  const turnBegan = `${T0 - 2 * MIN}\tworker-9/claim-stalled/row-460/nudge-1\n`;
  const old = dirOf(waiting, 5);
  assert.deepEqual(nudgedAt(world(old, turnBegan)), [], "agent-org#805: declared 5 minutes ago, before the prompt that began the turn 2 minutes ago: the open PR is still never a nudge");
  const fresh = dirOf(waiting, 1);
  assert.deepEqual(nudgedAt(world(fresh, turnBegan)), [], "declared 1 minute ago, after that prompt: no nudge either");
  const beforeClaim = dirOf(waiting, 30);
  assert.deepEqual(nudgedAt(world(beforeClaim)), [], "agent-org#805: declared before the claim began: still an open PR, still never a nudge");
  assert.equal(nudgedAt({ ...world(old, turnBegan), prs: [] })[0], M, "CONTROL: with the PR closed, the declaration is lapsed (its turn ended without declaring) and the worker is nudged at M");
  assert.deepEqual(tickAt(M, world(old, turnBegan), { 460: { session: "worker-9", idleSince: T0 } }), [], "and no order at all for the open PR");
});

// --- 3. `blocked` applies the label, and the excuse ends when it is removed -----------------------------------------------

test("`blocked` APPLIES the answer label and posts the reason; the excuse stands while the label does and ends when it is removed", () => {
  const { world, asked } = writableHost("a11ign/agent-org");
  const row = world.rows.get(460)!;
  const parsed = parse("blocked", "460", "the", "spelling", "is", "ambiguous");
  assert.ok("declaration" in parsed);
  const { lines } = applyBlocked(parsed.declaration, { gh: NO_RUN, tracker: "a11ign/agent-org", answerPrefix: ANSWER_PREFIX, writer: fakeWriter([]) });
  const wanted = `${ANSWER_PREFIX}${DEFAULT_ANSWERER}`;
  assert.deepEqual(row.labels, [wanted], "the label the gate reads as `answer:<session>`");
  assert.deepEqual(world.labelsCreated, [wanted], "the label exists in the repository (the fake refuses to apply one that does not)");
  assert.deepEqual(opsOf(asked), ["ensureTriageLabel", "addLabelToRowIn", "commentOnIssue"], "the label exists before it is applied, and the reason is posted");
  assert.ok(row.comments.at(-1)?.body.includes("the spelling is ambiguous"), "the comment is the reason");
  assert.match(lines.join("\n"), new RegExp(wanted));

  const dir = dirOf(parsed.declaration, 5);
  const withLabel = { row: rowOf(460, "worker-9", [...row.labels]), stateDir: dir };
  assert.deepEqual(nudgedAt(withLabel), [], "the row carries the label: an answer is owed, and the worker is not stalled");
  row.labels = row.labels.filter((label) => label !== wanted);
  const removed = { row: rowOf(460, "worker-9", [...row.labels]), stateDir: dir };
  assert.equal(nudgedAt(removed)[0], M, "the same declaration with the label removed: the excuse ended with it");
  const order = tickAt(M, removed, { 460: { session: "worker-9", idleSince: T0 } })[0];
  assert.match(order.prompt, /NO LONGER TRUE/);
});

test("`blocked` whose label GitHub refused writes NOTHING: the exit is 2 and the row is not read as blocked", async () => {
  const dir = scratch("refused-label");
  try {
    const { world } = writableHost("a11ign/agent-org");
    world.failures.set("ensureTriageLabel", Object.assign(new Error("HTTP 403"), { stderr: "HTTP 403: forbidden\n" }));
    const parsed = parse("blocked", "460", "why");
    assert.ok("declaration" in parsed);
    assert.throws(() => applyBlocked(parsed.declaration, { gh: NO_RUN, tracker: "a11ign/agent-org", answerPrefix: ANSWER_PREFIX, writer: fakeWriter([]) }), /403/);
    assert.deepEqual([world.rows.get(460)!.labels, world.rows.get(460)!.comments], [[], []], "and nothing was labelled or posted on the row");
    assert.deepEqual(readDeclarations(`${dir}/${WORKER_STATE_DIR}`)?.byClaimant.size, 0, "`main` writes only after the label stood, so nothing is on disk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3b. a ruling already given to this reason is not answered by a repeat (agent-org#1493) ------------------------------

const SESSION_460 = "worker-agent-org-460";
const REASON = "the spelling is ambiguous";
const OWN_AT = "2026-10-15T15:31:15Z";
const RULED_AT = "2026-10-15T15:37:10Z";
const row460 = (...more: string[]): string => `https://github.com/a11ign/agent-org/issues/460${more.join("")}`;
/** The worker's own `BLOCKED` comment, as `applyLabel` posts it: the header names the session and the reason, then the owed seat. */
const blockedComment = (session: string, reason: string, createdAt: string, id: number): RowComment => ({
  id: `IC_${id}`, url: row460(`#issuecomment-${id}`), createdAt,
  body: `BLOCKED (\`${session}\`, declared with \`worker:state\`): ${reason}\n\nOwed by \`product-manager\`; the row carries \`${ANSWER_PREFIX}product-manager\`.`,
});
/** A comment a seat posted, as `plugins/github/wrapper/gh` writes it: the author's text, then the `decided-by` line naming the seat (the last one is the seat's). */
const seatComment = (seat: string, createdAt: string, id: number, text = "Ruled: wait for the spelling."): RowComment => ({
  id: `IC_${id}`, url: row460(`#issuecomment-${id}`), createdAt, body: `${text}\n\n<!-- decided-by: ${seat} run: 4f2a -->`,
});
/** A second `blocked` declaration by `SESSION_460` for `reason`, read against the row's `comments` the way `main` reads them: what it asked the code host to write, and what it printed. */
function redeclare(reason: string, comments: RowComment[]): { written: string[]; lines: string[] } {
  const { asked } = writableHost("a11ign/agent-org");
  const parsed = parseDeclaration(["blocked", "460", ...reason.split(" ")], { session: SESSION_460, now: T0 });
  assert.ok("declaration" in parsed, JSON.stringify(parsed));
  const resolved = resolveBlockedRow(parsed.declaration, { trackers: TRACKERS, look: byNumber({ "a11ign/agent-org#460": { state: "OPEN", labels: [], comments } }), sessionLabel: `${SESSION_PREFIX}${SESSION_460}` });
  assert.ok("declaration" in resolved, JSON.stringify(resolved));
  const { lines } = applyBlocked(resolved.declaration, { gh: NO_RUN, tracker: "a11ign/agent-org", answerPrefix: ANSWER_PREFIX, writer: fakeWriter([]), comments: resolved.comments });
  return { written: opsOf(asked), lines };
}

test("POSITIVE CONTROL: a second `blocked` for a reason a manager has ruled on since the worker's own BLOCKED comment writes NO label and NO comment, and names the ruling", () => {
  const { written, lines } = redeclare(REASON, [blockedComment(SESSION_460, REASON, OWN_AT, 1), seatComment("product-manager", RULED_AT, 2)]);
  assert.deepEqual(written, [], "nothing is written: a ruling is not answered by a repeat, and the label is the contract");
  assert.equal(lines.length, 1, "one line is printed");
  assert.ok(lines[0].includes(row460("#issuecomment-2")), "the line names the ruling's comment");
  assert.ok(lines[0].includes(RULED_AT), "and the time it was given");
});

test("NEGATIVE CONTROLS: the ruling stops ONLY the repeat it answers: a different reason, a ruling older than the BLOCKED comment, a worker's own later comment, and no BLOCKED of this session are each labelled and commented as before", () => {
  const own = blockedComment(SESSION_460, REASON, OWN_AT, 1);
  const ruled = seatComment("product-manager", RULED_AT, 2);
  const three = ["ensureTriageLabel", "addLabelToRowIn", "commentOnIssue"];
  assert.deepEqual(redeclare("which label is it?", [own, ruled]).written, three, "a DIFFERENT reason is declared as today");
  assert.deepEqual(redeclare(REASON, [seatComment("product-manager", "2026-10-15T15:00:00Z", 3), own]).written, three, "a ruling OLDER than the last BLOCKED comment answers nothing new");
  assert.deepEqual(redeclare(REASON, [own, seatComment("worker-agent-org-9", RULED_AT, 4, "quoting nobody")]).written, three, "a comment by a WORKER is no ruling");
  assert.deepEqual(redeclare(REASON, [blockedComment("worker-agent-org-9", REASON, OWN_AT, 5), ruled]).written, three, "another session's BLOCKED for the same reason is not this worker's own");
  assert.deepEqual(redeclare(REASON, [ruled]).written, three, "with no BLOCKED comment of its own there is nothing the ruling could answer");
});

test("`rulingOn` takes every manager seat's marker as a ruling, and the newest manager comment decides (twin: a newer comment by another seat is still the manager's)", () => {
  for (const seat of MANAGER_SEATS) {
    const ruling = rulingOn([blockedComment(SESSION_460, REASON, OWN_AT, 1), seatComment(seat, RULED_AT, 2)], blockedDeclaration());
    assert.equal(ruling?.id, "IC_2", `${seat} is a manager seat, so its comment is a ruling`);
  }
  const older = seatComment("orchestrator", "2026-10-15T15:35:00Z", 6);
  const newest = seatComment("ceo", "2026-10-15T15:50:00Z", 7);
  assert.equal(rulingOn([blockedComment(SESSION_460, REASON, OWN_AT, 1), newest, older], blockedDeclaration())?.id, "IC_7");
});

/** The declaration a `blocked` with {@link REASON} makes, for `rulingOn` read on its own. */
function blockedDeclaration(): Declaration {
  const parsed = parseDeclaration(["blocked", "460", ...REASON.split(" ")], { session: SESSION_460, now: T0 });
  assert.ok("declaration" in parsed, JSON.stringify(parsed));
  return parsed.declaration;
}

// --- 4. a session herdr reports `blocked` is told once per stall ---------------------------------------------------------

test("a `blocked` herdr session is sent the declare-or-decide instruction ONCE, and a second tick sends none; a stall that ended and began again is told again", () => {
  const dir = scratch("told");
  const path = `${dir}/${BLOCKED_TOLD_FILE}`;
  const sent: [string, string][] = [];
  const send = (label: string, text: string) => { sent.push([label, text]); };
  const roster = (status: string) => [...STANDING, { label: "worker-4202", status }, { label: "worker-4203", status: "working" }];
  try {
    const first = tellBlocked({ roster: roster("blocked"), path, send });
    assert.deepEqual(first.sent, ["worker-4202"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], "worker-4202");
    assert.match(sent[0][1], /agent-org worker:state blocked <row> <reason>/, "it names the command");
    assert.match(sent[0][1], /DECIDE IT YOURSELF/, "or to decide and record why");
    assert.equal(sent[0][1], blockedInstruction("worker-4202"));

    const second = tellBlocked({ roster: roster("blocked"), path, send });
    assert.deepEqual(second, { sent: [], untold: [] }, "the same stall, a second tick: nothing sent, and nothing left to log as `BLOCKED`");
    assert.equal(sent.length, 1);

    tellBlocked({ roster: roster("working"), path, send });
    assert.equal(sent.length, 1, "the pane went back to work: nothing sent, and the stall is over");
    tellBlocked({ roster: roster("blocked"), path, send });
    assert.equal(sent.length, 2, "twin: blocked AGAIN is a new stall and is told again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed send is retried next tick and named, not recorded as told; only worker sessions are told", () => {
  const dir = scratch("told-failed");
  const path = `${dir}/${BLOCKED_TOLD_FILE}`;
  const report: string[] = [];
  let attempts = 0;
  const flaky = () => { if (++attempts === 1) throw new Error("herdr: no such pane"); };
  const roster = [...STANDING, { label: "worker-4202", status: "blocked" }, { label: "reviewer-9", status: "blocked" }];
  try {
    const first = tellBlocked({ roster, path, send: flaky, report: (line) => report.push(line) });
    assert.deepEqual(first.sent, []);
    assert.match(report.join("\n"), /worker-4202: the declare-or-decide instruction could not be sent/);
    assert.deepEqual(first.untold.sort(), ["reviewer-9", "worker-4202"], "both are still reported as blocked: nobody was told");
    const second = tellBlocked({ roster, path, send: flaky, report: (line) => report.push(line) });
    assert.deepEqual(second.sent, ["worker-4202"], "retried, and told");
    assert.deepEqual(second.untold, ["reviewer-9"], "a reviewer is not a worker: it is reported as before, never sent a worker's instruction");
    assert.equal(attempts, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`blockedToTell` is pure: who is due and who is remembered, both from the listing and the memory", () => {
  const roster = [{ label: "worker-1", status: "blocked" }, { label: "worker-2", status: "blocked" }, { label: "worker-3", status: "idle" }, { label: "ceo", status: "blocked" }];
  assert.deepEqual(blockedToTell(roster, ["worker-2", "worker-3"]), { send: ["worker-1"], told: ["worker-2"] });
  assert.deepEqual(blockedToTell(roster, []), { send: ["worker-1", "worker-2"], told: [] });
});

// --- 5. WHICH TRACKER'S ROW (a11ign/a11ign#460 was labelled by this command's first version) ----------------------------------------------
//
// The command took the HOME tracker's repository for every number. A worker on `a11ign/agent-org#460` declared `blocked 460`, and the label and
// the comment went to `a11ign/a11ign#460`, a row closed a month before, whose reader was woken for nothing. The tests below run it against two
// declared trackers that both have a row 460, with `gh` as a fixture, never a live tracker.
const TRACKERS = [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }];
const CLAIM_LABEL = `${SESSION_PREFIX}worker-agent-org-460`;
const rowsOf = (table: Record<string, RowFact>): RowLook => (repo) => table[repo] ?? null;
const BOTH: Record<string, RowFact> = {
  "a11ign/a11ign": { state: "CLOSED", labels: [] },
  "a11ign/agent-org": { state: "OPEN", labels: [CLAIM_LABEL, "in-progress"] },
};
const blockedOn = (ref: string) => {
  const parsed = parseDeclaration(["blocked", ref, "which", "tracker?"], { session: "worker-agent-org-460", now: T0 });
  assert.ok("declaration" in parsed, JSON.stringify(parsed));
  return parsed.declaration;
};
const resolve = (ref: string, table: Record<string, RowFact>) => resolveBlockedRow(blockedOn(ref), { trackers: TRACKERS, look: rowsOf(table), sessionLabel: CLAIM_LABEL });
const refusalNamed = (result: ReturnType<typeof resolve>): { refused: string; why: string } | null => ("refused" in result ? result.refused : null);
const refusalOfClose = (result: ReturnType<typeof resolveDone>): { refused: string; why: string } | null => ("refused" in result ? result.refused : null);

test("a bare number that is a row in two trackers is read from the CLAIM: the one carrying this session's label, never the first tracker's", () => {
  const result = resolve("460", BOTH);
  assert.ok("declaration" in result, JSON.stringify(result));
  assert.equal(result.declaration.repo, "a11ign/agent-org");
  assert.equal(result.declaration.rowKey, undefined, "the typed key is resolved away, so the file holds the repository and not the spelling");
});

test("POSITIVE CONTROL: the version this replaces wrote the first tracker's row, closed, which is the row the product-manager was woken on", () => {
  const first = writableHost(TRACKERS[0].repo);
  applyBlocked(blockedOn("460"), { gh: NO_RUN, tracker: TRACKERS[0].repo, answerPrefix: ANSWER_PREFIX, writer: fakeWriter([]) });
  assert.ok(first.asked.some(({ repo }) => repo === "a11ign/a11ign"), "the old call targeted a11ign/a11ign#460");
  const second = writableHost("a11ign/agent-org");
  const result = resolve("460", BOTH);
  assert.ok("declaration" in result);
  applyBlocked(result.declaration, { gh: NO_RUN, tracker: result.declaration.repo as string, answerPrefix: ANSWER_PREFIX, writer: fakeWriter([]) });
  assert.ok(second.asked.length === 3 && second.asked.every(({ repo }) => repo === "a11ign/agent-org"), JSON.stringify(second.asked));
  assert.deepEqual(first.world.rows.get(460)!.labels, [`${ANSWER_PREFIX}${DEFAULT_ANSWERER}`], "and the row it labelled is the first tracker's");
});

test("a bare number in two trackers with NEITHER carrying the claim label is REFUSED, naming both (twin: the keyed spelling resolves)", () => {
  const unclaimed = { ...BOTH, "a11ign/agent-org": { state: "OPEN" as const, labels: [] } };
  const refusal = refusalNamed(resolve("460", unclaimed));
  assert.equal(refusal?.refused, "ambiguous-row");
  assert.ok(refusal?.why.includes("a11ign/a11ign#460") && refusal.why.includes("agent-org#460"), refusal?.why);
  const keyed = resolve("agent-org#460", unclaimed);
  assert.ok("declaration" in keyed && keyed.declaration.repo === "a11ign/agent-org");
  const byRepo = resolve("a11ign/agent-org#460", unclaimed);
  assert.ok("declaration" in byRepo && byRepo.declaration.repo === "a11ign/agent-org", "a tracker is also named by its owner/name, which is how the first one is spelt");
});

test("a keyed reference names its tracker, and an undeclared key is REFUSED by name, listing the declared ones", () => {
  const refusal = refusalNamed(resolve("lab#460", BOTH));
  assert.equal(refusal?.refused, "unknown-tracker");
  assert.ok(refusal?.why.includes("agent-org") && refusal.why.includes("a11ign/a11ign"), refusal?.why);
});

test("`blocked` on a CLOSED row is REFUSED, naming the state and the reopening (twin: the same row open is accepted)", () => {
  const closedKeyed = refusalNamed(resolve("a11ign/a11ign#460", BOTH));
  assert.equal(closedKeyed?.refused, "row-closed");
  assert.ok(closedKeyed?.why.includes("CLOSED") && closedKeyed.why.includes("gh issue reopen 460 --repo a11ign/a11ign"), closedKeyed?.why);
  const onlyClosed = refusalNamed(resolve("460", { "a11ign/a11ign": { state: "CLOSED", labels: [] } }));
  assert.equal(onlyClosed?.refused, "row-closed", "the one row of that number is closed, so a bare number does not label it either");
  const open = resolve("460", { "a11ign/a11ign": { state: "OPEN", labels: [] } });
  assert.ok("declaration" in open && open.declaration.repo === "a11ign/a11ign", "an open row in the one tracker that has it is accepted");
});

// --- 5. `--on`: a native edge from the held row to the row it waits on, and NO label -------------------------------------------

/** A row fixture by repository AND number, for the `--on` cases, where the two rows can be in one repository. */
const byNumber = (table: Record<string, RowFact>): RowLook => (repo, number) => table[`${repo}#${number}`] ?? null;
const ON_OPEN: Record<string, RowFact> = {
  "a11ign/agent-org#12": { state: "OPEN", labels: [] },
  "a11ign/agent-org#7": { state: "OPEN", labels: [] },
};
const waitingOn = (row: string, on: string): Declaration => {
  const parsed = parseDeclaration(["blocked", row, "waiting", "on", "the", "decision"], { session: "worker-agent-org-12", now: T0, on });
  assert.ok("declaration" in parsed, JSON.stringify(parsed));
  return parsed.declaration;
};
const resolveOn = (row: string, on: string, table: Record<string, RowFact>) =>
  resolveBlockedRow(waitingOn(row, on), { trackers: TRACKERS, look: byNumber(table), sessionLabel: `${SESSION_PREFIX}worker-agent-org-12` });
/** A port writer fixture: each edge is recorded, and `failing` makes it throw as GitHub refusing the write does. The real writer is `githubTicketAdapter`, tested in `ticket-port.test.ts`. */
const fakeWriter = (edges: { ref: ItemRef; blocker: ItemRef }[], failing = false): BlockerWriter => ({
  addBlocker(ref, blocker) {
    if (failing) throw Object.assign(new Error("HTTP 422"), { stderr: "HTTP 422: Validation Failed\n" });
    edges.push({ ref, blocker });
  },
});
/** The edge `blocked 12 --on 7` names in `a11ign/agent-org`, which is what the port is asked to write. */
const WRITTEN_EDGE = { ref: { tracker: TRACKER, scope: "a11ign/agent-org", id: 12 }, blocker: { tracker: TRACKER, scope: "a11ign/agent-org", id: 7 } };

test("POSITIVE CONTROL: `blocked 12 --on 7` with 7 open writes the native edge and posts the reason, and makes NO label call", () => {
  const { asked } = writableHost("a11ign/agent-org");
  const edges: { ref: ItemRef; blocker: ItemRef }[] = [];
  const result = resolveOn("12", "7", ON_OPEN);
  assert.ok("declaration" in result, JSON.stringify(result));
  assert.equal(result.declaration.onRepo, "a11ign/agent-org", "the row it waits on is resolved, and its repository is kept");
  const { lines, declaration } = applyBlocked(result.declaration, { gh: NO_RUN, tracker: result.declaration.repo as string, answerPrefix: ANSWER_PREFIX, writer: fakeWriter(edges) });
  assert.deepEqual(edges, [WRITTEN_EDGE], "the native edge is written through the port: 12 is blocked by 7, each in the repository it is in");
  assert.deepEqual(opsOf(asked), ["commentOnIssue"], "the reason is the only write asked of the code host: the edge is the port's write, and worker-state.ts names no edge call");
  const body = String(asked[0].body);
  assert.ok(body.includes("the decision") && body.includes("a11ign/agent-org#7"), "the comment is the reason, and names what it waits on");
  assert.deepEqual(asked.filter(({ op }) => op !== "commentOnIssue"), [], "NO label call: nobody is owed an answer when the edge is the answer");
  assert.equal(declaration.to, undefined, "nothing on disk owes an answer");
  assert.equal(declaration.on, 7);
  assert.match(lines.join("\n"), /native edge, no label/);
});

test("NEGATIVE CONTROL: `blocked 12` with NO `--on` keeps the label and the comment, with the writes pinned as the requests they are", () => {
  const { asked, world } = writableHost("a11ign/agent-org");
  const parsed = parseDeclaration(["blocked", "12", "which", "label", "is", "it?"], { session: "worker-agent-org-12", now: T0 });
  assert.ok("declaration" in parsed);
  const resolved = resolveBlockedRow(parsed.declaration, { trackers: TRACKERS, look: byNumber(ON_OPEN), sessionLabel: `${SESSION_PREFIX}worker-agent-org-12` });
  assert.ok("declaration" in resolved, JSON.stringify(resolved));
  const edges: { ref: ItemRef; blocker: ItemRef }[] = [];
  const { declaration } = applyBlocked(resolved.declaration, { gh: NO_RUN, tracker: "a11ign/agent-org", answerPrefix: ANSWER_PREFIX, writer: fakeWriter(edges) });
  const label = `${ANSWER_PREFIX}${DEFAULT_ANSWERER}`;
  const body = `BLOCKED (\`worker-agent-org-12\`, declared with \`worker:state\`): which label is it?\n\nOwed by \`${DEFAULT_ANSWERER}\`; the row carries \`${label}\`.`;
  assert.deepEqual(asked, [
    { op: "ensureTriageLabel", repo: "a11ign/agent-org", label, description: "a session owes this row an answer" },
    { op: "addLabelToRowIn", repo: "a11ign/agent-org", number: 12, label },
    { op: "commentOnIssue", repo: "a11ign/agent-org", issue: "12", body },
  ], "the label is created, applied, and the reason posted, with the requests pinned as literals (the argument lists they become are the plugin's tests')");
  assert.deepEqual([world.rows.get(12)!.labels, world.rows.get(12)!.comments.map((comment) => comment.body)], [[label], [body]], "and they landed on the row");
  assert.deepEqual(edges, [], "and no edge is written: without `--on` the port is never asked");
  assert.equal(declaration.to, DEFAULT_ANSWERER);
  assert.equal(declaration.on, undefined);
});

test("NEGATIVE CONTROL: `--on` of a CLOSED row is REFUSED by name, and nothing is labelled (twin: the same row open is accepted)", () => {
  const refusal = refusalNamed(resolveOn("12", "7", { ...ON_OPEN, "a11ign/agent-org#7": { state: "CLOSED", labels: [] } }));
  assert.equal(refusal?.refused, "on-closed");
  assert.ok(refusal?.why.includes("CLOSED") && refusal.why.includes("no `blockedBy` edge is written"), refusal?.why);
  assert.ok("declaration" in resolveOn("12", "7", ON_OPEN), "twin: the open row is accepted");
  // `main` returns on the refusal before `applyBlocked` is reached, so no `gh` call labels or edges anything for it.
});

test("NEGATIVE CONTROL: `blocked 12 --on 12` is REFUSED as the row itself, and nothing is labelled (twin: `--on 7` is accepted)", () => {
  assert.equal(refusalNamed(resolveOn("12", "12", ON_OPEN))?.refused, "on-self");
  assert.ok("declaration" in resolveOn("12", "7", ON_OPEN));
});

test("NEGATIVE CONTROL: a failed edge write FALLS BACK to the label, so the worker is never blocked with nobody told (twin: the edge that succeeds labels nothing)", () => {
  const label = `${ANSWER_PREFIX}${DEFAULT_ANSWERER}`;
  const result = resolveOn("12", "7", ON_OPEN);
  assert.ok("declaration" in result);
  const refused = writableHost("a11ign/agent-org");
  const refusedEdges: { ref: ItemRef; blocker: ItemRef }[] = [];
  const edgeRefused = applyBlocked(result.declaration, { gh: NO_RUN, tracker: "a11ign/agent-org", answerPrefix: ANSWER_PREFIX, writer: fakeWriter(refusedEdges, true) });
  assert.deepEqual(refusedEdges, [], "the edge was attempted and refused, so none is recorded");
  assert.deepEqual(refused.world.rows.get(12)!.labels, [label], "the label is applied after the edge is refused");
  assert.equal(edgeRefused.declaration.to, DEFAULT_ANSWERER, "the declaration on disk is the labelled one, owed by the default answerer");
  assert.equal(edgeRefused.declaration.on, undefined, "and it carries no edge the gate would read as a block nobody answers");
  assert.match(edgeRefused.lines.join("\n"), /could not write the blockedBy edge on #7 of a11ign\/agent-org .*labelled instead/);

  const edgeOk = writableHost("a11ign/agent-org");
  const okEdges: { ref: ItemRef; blocker: ItemRef }[] = [];
  const ok = applyBlocked(result.declaration, { gh: NO_RUN, tracker: "a11ign/agent-org", answerPrefix: ANSWER_PREFIX, writer: fakeWriter(okEdges) });
  assert.deepEqual(edgeOk.world.rows.get(12)!.labels, [], "twin: when the edge is written, no label is applied");
  assert.deepEqual(okEdges, [WRITTEN_EDGE], "twin: and the edge is the one written");
  assert.equal(ok.declaration.on, 7);
});

test("NEGATIVE CONTROL: the gate reads a holder BLOCKED by `--on` the way the shipped decider does: released when nothing is built, HOLDING while it has dirty files or unpushed commits (twin: the same claim with no edge is read by the clock)", () => {
  const claim = (work: ReturnType<ClaimFacts["work"]>, blockedBy: number[]): ClaimFacts => ({
    row: 12, session: "worker-agent-org-12", claimedAt: T0, branch: "agent/x", worktree: "/w", comment: null, commit: () => null, push: () => null,
    file: () => null, work: () => work, openPrs: 0, mergedPr: null, waiting: null, blockedBy,
  });
  const ctx = { now: T0 + 60 * MIN, restartAt: null, agents: null, nudge: null, goneSince: null, idleSince: null };
  const clean = { state: "none" as const, dirty: 0, unpushed: 0 };
  const dirty = { state: "at-risk" as const, dirty: 2, unpushed: 1 };

  const released = readClaim(claim(clean, [7]), ctx);
  assert.ok(released.kind === "release" && released.why === "blocked", JSON.stringify(released));
  assert.deepEqual(released.kind === "release" ? released.edges : null, [7], "the edge is the reason, and it is the one written");
  assert.equal(readClaim(claim(dirty, [7]), ctx).kind, "holding", "a dirty holder is HELD, not released by the edge");
  const plain = readClaim(claim(clean, []), ctx);
  assert.ok(!(plain.kind === "release" && plain.why === "blocked"), `twin: with no edge the same clean claim is not read as blocked (${JSON.stringify(plain)})`);
});

test("`--on` names a row by its tracker key, and an undeclared key is REFUSED by name, as the held row is", () => {
  const keyed = resolveOn("12", "agent-org#7", ON_OPEN);
  assert.ok("declaration" in keyed && keyed.declaration.onRepo === "a11ign/agent-org");
  const undeclared = refusalNamed(resolveOn("12", "lab#7", ON_OPEN));
  assert.equal(undeclared?.refused, "unknown-tracker");
});

test("no row of that number, and a row that could not be read, are REFUSED by name and neither is read as `closed` or `absent` for the other", () => {
  assert.equal(refusalNamed(resolve("999", {}))?.refused, "no-such-row");
  const throwing = resolveBlockedRow(blockedOn("460"), { trackers: TRACKERS, look: () => { throw new Error("HTTP 502"); }, sessionLabel: CLAIM_LABEL });
  const refusal = refusalNamed(throwing);
  assert.equal(refusal?.refused, "unreadable-row");
  assert.ok(refusal?.why.includes("HTTP 502"), refusal?.why);
  const { world } = writableHost("a11ign/agent-org");
  world.failures.set("rowWithCommentsOf", new Error("gh issue view of #460 of a11ign/a11ign carried no comments field, so no ruling can be read"));
  const noComments = resolveBlockedRow(blockedOn("460"), { trackers: TRACKERS, look: ghRowLook(NO_RUN), sessionLabel: CLAIM_LABEL });
  assert.equal(refusalNamed(noComments)?.refused, "unreadable-row", "a row the code host could not read in full (no comments field: no ruling could be read) refuses the row, so nothing is labelled");
});

test("`ghRowLook` asks the code host for the row (state, labels, comments, body): a row it holds as the look reads it, no such issue as null, and any other refusal thrown", () => {
  const { world } = writableHost("a11ign/a11ign", {});
  world.rows.set(460, fakeRow(world, 460, { state: "CLOSED", labels: ["x"], body: "B", comments: [{ id: 41, body: "b", createdAt: "2026-10-10T08:00:00Z" }] }));
  world.rows.set(461, fakeRow(world, 461));
  assert.deepEqual(ghRowLook(NO_RUN)("a11ign/a11ign", 460), { state: "CLOSED", labels: ["x"], comments: [{ id: "41", url: "https://github.com/a11ign/a11ign/issues/460#issuecomment-41", body: "b", createdAt: "2026-10-10T08:00:00Z" }], body: "B" });
  assert.deepEqual(ghRowLook(NO_RUN)("a11ign/a11ign", 461), { state: "OPEN", labels: [], comments: [], body: "" });
  assert.equal(ghRowLook(NO_RUN)("a11ign/a11ign", 9999), null, "no such issue");
  world.failures.set("rowWithCommentsOf", new Error("HTTP 502"));
  assert.throws(() => ghRowLook(NO_RUN)("a11ign/a11ign", 460), /HTTP 502/);
});

test("a `blocked` declaration for the row of ANOTHER repository does not excuse this claim (twin: its own repository does)", () => {
  const own = { ...decl({ state: "blocked", pr: undefined, row: 460, to: DEFAULT_ANSWERER }), repo: "a11ign/agent-org" };
  assert.equal(declarationReading(own, ctx({ answersOwed: [DEFAULT_ANSWERER], repo: "a11ign/agent-org" })).kind, "excused");
  assert.equal(declarationReading(own, ctx({ answersOwed: [DEFAULT_ANSWERER], repo: "a11ign/a11ign" })).kind, "lapsed", "row 460 of a11ign/a11ign is another row");
  assert.equal(declarationReading({ ...own, repo: undefined }, ctx({ answersOwed: [DEFAULT_ANSWERER], repo: "a11ign/a11ign" })).kind, "excused", "a declaration written before the repository was recorded is read as before");
});

// --- `done` closes a row only on a reading (agent-org#1536) ------------------------------------------------------------

const DONE_WHEN = ["the gate reads the reading", "the close comment names each item"];
const READ_AT = (item: number) => ({ item, comment: `https://github.com/a11ign/agent-org/issues/1536#issuecomment-${item}` });
const readingCtx = (over: Partial<ClaimContext> = {}): ClaimContext => ctx({ nothing: true, doneWhen: DONE_WHEN, ...over });
const doneRead = (met?: DoneWhenReading[]): Declaration => decl({ state: "done", pr: undefined, ...(met === undefined ? {} : { row: 460, met }) });
const whyOf = (reading: DeclarationReading): string => ("why" in reading ? reading.why : "");

test("POSITIVE CONTROL (a): `done` on a `Claimed-nothing:` claim with every Done-when item read as met is EXCUSED, and the reading is named (twin: no reading named is lapsed)", () => {
  assert.deepEqual(declarationReading(doneRead([READ_AT(1), READ_AT(2)]), readingCtx()), { kind: "excused", state: "done", why: "the reading is recorded and the row is closed" });
  assert.equal(declarationReading(doneRead(), readingCtx()).kind, "lapsed", "the twin: the same `done` with no reading says nothing was read, so it is not an excuse");
});

test("POSITIVE CONTROL (b): one Done-when item left unmet is LAPSED, naming the item (twin: the same reading with both items is excused)", () => {
  const one = declarationReading(doneRead([READ_AT(1)]), readingCtx());
  assert.equal(one.kind, "lapsed");
  assert.match(whyOf(one), /Done-when 2 \(the close comment names each item\)/);
  assert.doesNotMatch(whyOf(one), /Done-when 1 /, "item 1 is read, so it is not named");
  assert.equal(declarationReading(doneRead([READ_AT(1), READ_AT(2)]), readingCtx()).kind, "excused");
});

test("NEGATIVE CONTROL (c): `done` on a claim WITH a pull request reads exactly as before, and a reading does not stand in for the merge (twin: the merged one is excused)", () => {
  const open = readingCtx({ nothing: false, ownPrs: [{ number: 9001 }] });
  const withPr = declarationReading(doneRead([READ_AT(1), READ_AT(2)]), open);
  assert.equal(withPr.kind, "lapsed");
  assert.equal(whyOf(withPr), "the row is still open and no pull request of it has merged", "the same sentence as today");
  assert.equal(declarationReading(doneRead([READ_AT(1), READ_AT(2)]), readingCtx({ nothing: false, mergedPr: { number: 9001 } })).kind, "excused");
  assert.equal(declarationReading(doneRead([READ_AT(1), READ_AT(2)]), readingCtx({ nothing: true, mergedPr: null })).kind, "excused", "the reading's own claim, not a merge, is what excuses it");
});

test("the reading is for the row the claim holds: a reading of ANOTHER row lapses, and a claim with no Done-when items has nothing to read as met", () => {
  const other = { ...doneRead([READ_AT(1), READ_AT(2)]), row: 999 };
  assert.match(whyOf(declarationReading(other, readingCtx())), /it names #999, and the row you hold is #460/);
  assert.match(whyOf(declarationReading(doneRead([READ_AT(1)]), readingCtx({ doneWhen: [] }))), /has no Done-when items/);
});

test("`done <row> --met=<item>:<comment>,...` is accepted; the bare `done` is as before; each malformed form is REFUSED by name (twin: the well-formed one is accepted)", () => {
  const refusedAs = (result: ReturnType<typeof parseDeclaration>): string | null => ("refused" in result ? result.refused.refused : null);
  const read = parseDeclaration(["done", "1536"], { session: "worker-9", now: T0, met: "1:IC_1,2:IC_2" });
  assert.ok("declaration" in read);
  assert.deepEqual(read.declaration, { session: "worker-9", state: "done", at: T0, row: 1536, met: [{ item: 1, comment: "IC_1" }, { item: 2, comment: "IC_2" }] });
  const keyed = parseDeclaration(["done", "agent-org#1536"], { session: "worker-9", now: T0, met: "1:IC_1" });
  assert.ok("declaration" in keyed && keyed.declaration.rowKey === "agent-org" && keyed.declaration.row === 1536);
  assert.deepEqual(parseDeclaration(["done"], { session: "worker-9", now: T0 }), { declaration: { session: "worker-9", state: "done", at: T0 } }, "the bare `done` is unchanged");
  assert.equal(refusedAs(parseDeclaration(["done", "1536"], { session: "worker-9", now: T0 })), "missing-met", "a row with no reading is not a close");
  assert.equal(refusedAs(parseDeclaration(["done", "1536"], { session: "worker-9", now: T0, met: "1" })), "bad-met");
  assert.equal(refusedAs(parseDeclaration(["done", "1536"], { session: "worker-9", now: T0, met: "0:IC_1" })), "bad-met", "items start at 1");
  assert.equal(refusedAs(parseDeclaration(["done", "1536"], { session: "worker-9", now: T0, met: "1:IC_1,1:IC_2" })), "bad-met", "an item is read once");
  assert.equal(refusedAs(parseDeclaration(["done"], { session: "worker-9", now: T0, met: "1:IC_1" })), "missing-row");
  assert.equal(refusedAs(parseDeclaration(["done", "1536", "extra"], { session: "worker-9", now: T0, met: "1:IC_1" })), "unexpected-argument");
  assert.equal(refusedAs(parseDeclaration(["done", "x"], { session: "worker-9", now: T0, met: "1:IC_1" })), "bad-row");
  assert.equal(refusedAs(parseDeclaration(["waiting-ci", "9001"], { session: "worker-9", now: T0, met: "1:IC_1" })), "unexpected-argument", "`--met` is `done`'s and no other state's");
  assert.deepEqual(parseMet("1:https://x/y#issuecomment-1"), { met: [{ item: 1, comment: "https://x/y#issuecomment-1" }] }, "the URL's own colon stays in the comment");
});

test("`--met` is one of the flags, in both spellings (twin: a fifth flag is still unknown)", () => {
  assert.deepEqual(splitArgs(["done", "1536", "--met=1:IC_1"]).flags, { met: "1:IC_1" });
  assert.deepEqual(splitArgs(["done", "1536", "--met", "1:IC_1"]).flags, { met: "1:IC_1" });
  assert.deepEqual(splitArgs(["done", "--color=red"]).unknown, ["--color=red"]);
});

// The row a `done --met` closes, as `gh issue view` reads it: one tracker, held by `worker-agent-org-1536` under `Claimed-nothing:`.
const claimedNothing = (at = T0 - 60 * MIN): RowComment => ({ id: "IC_0", url: "u0", body: claimRecordComment({ session: "worker-agent-org-1536", nothing: "no pull request: the reading closes it" }), createdAt: new Date(at).toISOString() });
const readsOf = (comments: RowComment[], body = "") => byNumber({ "a11ign/a11ign#1536": { state: "OPEN", labels: [CLAIM_LABEL], body, comments } });
const reads = [{ id: "IC_1", url: "u1", body: "VERIFIED: the gate reads it", createdAt: new Date(T0 - 20 * MIN).toISOString() }, { id: "IC_2", url: "u2", body: "VERIFIED: the close names it", createdAt: new Date(T0 - 19 * MIN).toISOString() }];
const closeWith = (met: string) => parseDeclaration(["done", "1536"], { session: "worker-agent-org-1536", now: T0, met });
const resolveClose = (met: string, comments: RowComment[]) => {
  const parsed = closeWith(met);
  assert.ok("declaration" in parsed);
  return resolveDone(parsed.declaration, { trackers: TRACKERS, look: readsOf(comments), sessionLabel: CLAIM_LABEL, doneWhenOf: () => DONE_WHEN });
};

test("POSITIVE CONTROL: a row claimed `Claimed-nothing:` closes on a reading that names every Done-when item and the comment holding it (twin: the same reading with item 2 left out is refused, naming it)", () => {
  const closed = resolveClose("1:IC_1,2:IC_2", [claimedNothing(), ...reads]);
  assert.ok("declaration" in closed, JSON.stringify(closed));
  assert.deepEqual(closed.declaration.met, [{ item: 1, comment: "u1" }, { item: 2, comment: "u2" }], "the comment URLs are what the closing comment cites");
  assert.equal(closed.declaration.repo, "a11ign/a11ign");
  const partial = resolveClose("1:IC_1", [claimedNothing(), ...reads]);
  assert.equal(refusalOfClose(partial)?.refused, "unmet-done-when");
  assert.match(refusalOfClose(partial)?.why ?? "", /Done-when 2 \(the close comment names each item\) has no reading/);
});

test("NEGATIVE CONTROLS: a close is REFUSED by name when the claim has a pull request, when a comment named is not on the row, and when an item is not an item (twin: each accepted form above)", () => {
  assert.ok("declaration" in resolveClose("1:IC_1,2:IC_2", [claimedNothing(), ...reads]), "the control: this one is accepted");
  const withPr = byNumber({ "a11ign/a11ign#1536": { state: "OPEN", labels: [CLAIM_LABEL], body: "", comments: [{ ...claimedNothing(), body: claimRecordComment({ session: "worker-agent-org-1536", branch: "agent/x", worktree: "/w" }) }, ...reads] } });
  const parsed = closeWith("1:IC_1,2:IC_2");
  assert.ok("declaration" in parsed);
  assert.equal(refusalOfClose(resolveDone(parsed.declaration, { trackers: TRACKERS, look: withPr, sessionLabel: CLAIM_LABEL, doneWhenOf: () => DONE_WHEN }))?.refused, "no-claim");
  assert.equal(refusalOfClose(resolveClose("1:IC_1,2:IC_9", [claimedNothing(), ...reads]))?.refused, "unknown-comment", "IC_9 is not a comment on the row");
  assert.equal(refusalOfClose(resolveClose("1:IC_1,3:IC_2", [claimedNothing(), ...reads]))?.refused, "bad-met", "the row has two items");
  assert.equal(refusalOfClose(resolveClose("1:IC_1,2:IC_2", []))?.refused, "no-claim", "no claim at all is not a reading's to close");
});

test("the closing comment names each Done-when item and the comment that holds its reading, so the close can be checked", () => {
  const text = closingComment("worker-agent-org-1536", DONE_WHEN, [READ_AT(1), READ_AT(2)]);
  assert.match(text, /^Closed by `worker-agent-org-1536`/);
  assert.match(text, /1\. the gate reads the reading — read as met in https:\/\/github\.com\/a11ign\/agent-org\/issues\/1536#issuecomment-1$/m);
  assert.match(text, /2\. the close comment names each item — read as met in https:\/\/github\.com\/a11ign\/agent-org\/issues\/1536#issuecomment-2$/m);
});

// The detector: a claimant idle on an `in-progress` row whose own VERIFIED note has stood for VERIFIED_CLOSE_MINUTES orders the row closed.

const noteAt = (minutesBefore: number, body = "VERIFIED: both items hold", login = "claimant-account") => ({ url: `note-${minutesBefore}`, body, createdAt: new Date(T0 - minutesBefore * MIN).toISOString(), author: { login } });
const closeFacts = (over: Partial<Parameters<typeof verifiedCloseOrder>[0]> = {}) => ({ row: 1536, labels: ["in-progress"], claimant: "worker-agent-org-1536", claim: { at: T0 - 60 * MIN, author: "claimant-account" }, comments: [noteAt(16)], idleSince: T0 - 30 * MIN, ...over });

test("POSITIVE CONTROL (d): an idle claimant's VERIFIED note 16 minutes old orders the row closed, to `product-manager`, naming the note (twin: at 14 minutes it does not)", () => {
  assert.equal(VERIFIED_CLOSE_MINUTES, 15);
  const order = verifiedCloseOrder(closeFacts(), { now: T0 });
  assert.deepEqual(order && { kind: order.kind, row: order.row, to: order.to, note: order.note, claimant: order.claimant }, { kind: "close", row: 1536, to: "product-manager", note: "note-16", claimant: "worker-agent-org-1536" });
  assert.equal(verifiedCloseOrder(closeFacts({ comments: [noteAt(14)] }), { now: T0 }), null, "the twin: 14 minutes has not stood long enough");
});

test("the detector's other conditions each hold it back: the row is not in progress, the claimant is not idle, the note is not the claimant's, is older than the claim, or does not say VERIFIED (twins: each accepted)", () => {
  assert.equal(verifiedCloseOrder(closeFacts({ labels: [] }), { now: T0 }), null, "a row that is not in progress is not the gate's to close");
  assert.equal(verifiedCloseOrder(closeFacts({ idleSince: null }), { now: T0 }), null, "a claimant that is working is not idle");
  assert.equal(verifiedCloseOrder(closeFacts({ comments: [noteAt(16, "VERIFIED", "someone-else")] }), { now: T0 }), null, "another account's note is not the claimant's");
  assert.equal(verifiedCloseOrder(closeFacts({ comments: [noteAt(70)] }), { now: T0 }), null, "a note from before the claim is an earlier claim's");
  assert.equal(verifiedCloseOrder(closeFacts({ comments: [noteAt(16, "looks good")] }), { now: T0 }), null, "a note that says nothing of verified is not a reading");
  assert.ok(verifiedCloseOrder(closeFacts({ comments: [noteAt(16, "Done-when items 1 and 2 met")] }), { now: T0 }), "the Done-when reading counts too");
});
