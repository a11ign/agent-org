// no-token: gh -- no `gh`, `git` or `herdr` is run; the rows, pull requests, listing and clock are fixtures, `gh` is a recording seam, and the only files written are in temporary directories (a11ign/agent-org#460)
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
import { after, test } from "node:test";
import { claimStallTick } from "./work-gate.ts";
import { claimRecordComment } from "./row-claim.ts";
import { ANSWER_PREFIX, SESSION_PREFIX } from "./project-vocabulary.ts";
import { COMMANDS } from "./commands.ts";
import { STOPPED_CLAIMANT_MINUTES } from "./idle-claimant.ts";
import {
  BLOCKED_TOLD_FILE, DECLARED_STATES, DEFAULT_ANSWERER, WORKER_STATE_DIR, applyBlocked, blockedInstruction, blockedToTell, declarationReading,
  ghRowLook, lastDeliveredTo, main, parseDeclaration, readDeclarations, resolveBlockedRow, splitArgs, tellBlocked, writeDeclaration, type ClaimContext,
  type Declaration, type RowFact, type RowLook,
} from "./worker-state.ts";

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
  assert.equal(refusalOf("done", "12"), "unexpected-argument", "`done` takes nothing: a stray pull request is not silently dropped");
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

test("the flags are `--session` and `--to` and nothing else (twin: both spellings of a value)", () => {
  assert.deepEqual(splitArgs(["blocked", "460", "why", "--session=worker-9", "--to", "ceo"]), { words: ["blocked", "460", "why"], flags: { session: "worker-9", to: "ceo" }, unknown: [] });
  assert.deepEqual(splitArgs(["done", "--force"]).unknown, ["--force"]);
  assert.deepEqual(splitArgs(["done", "--session"]).unknown, ["--session"], "a flag with no value is refused, not read as empty");
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
  assert.equal(nudgedAt({ prs: [prOf(460)], stateDir: waiting })[0], M, "and once the checks have finished: the result is in, and a worker waiting on it has something to do");
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
  assert.equal(nudgedAt({ prs: [prOf(460, { pending: true })], stateDir: none })[0], M, "an open PR with a pending check is not a declaration");
  assert.equal(nudgedAt({ stateDir: none, status: "done" })[0], M);
  assert.deepEqual(nudgedAt({ stateDir: none, status: "working" }), [], "twin: a working worker is not idle");
  const [order] = tickAt(M, { stateDir: none }, { 460: { session: "worker-9", idleSince: T0 } });
  assert.equal(order.cause, "claim-stalled", "its ledger line is #458's `claimed-worker-stalled`, which the cause drives");
  assert.match(order.prompt, /YOU DECLARED NOTHING/);
  assert.match(order.prompt, /agent-org worker:state waiting-ci <pr>/);
  assert.match(order.prompt, /agent-org worker:state blocked <row> <reason>/);
});

test("a declaration OLDER than the worker's last turn is nudged at M, and the same one declared after that turn began is not", () => {
  const waiting = { state: "waiting-ci" as const, pr: { number: 9460 } };
  const world = (dir: string, ledger = ""): World => ({ prs: [prOf(460, { pending: true })], stateDir: dir, ledger });
  const turnBegan = `${T0 - 2 * MIN}\tworker-9/claim-stalled/row-460/nudge-1\n`;
  const old = dirOf(waiting, 5);
  assert.equal(nudgedAt(world(old, turnBegan))[0], M, "declared 5 minutes ago, but a prompt reached the worker 2 minutes ago: that turn ended without declaring");
  const fresh = dirOf(waiting, 1);
  assert.deepEqual(nudgedAt(world(fresh, turnBegan)), [], "the control: declared 1 minute ago, after that prompt");
  const beforeClaim = dirOf(waiting, 30);
  assert.equal(nudgedAt(world(beforeClaim))[0], M, "declared before the claim began: another claim's");
  const stale = tickAt(M, world(old, turnBegan), { 460: { session: "worker-9", idleSince: T0 } })[0];
  assert.match(stale.prompt, /BEFORE YOUR LAST TURN BEGAN/, "and the order says so, not that nothing was declared");
});

// --- 3. `blocked` applies the label, and the excuse ends when it is removed -----------------------------------------------

test("`blocked` APPLIES the answer label and posts the reason; the excuse stands while the label does and ends when it is removed", () => {
  const labels = new Set<string>();
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    const flag = args.indexOf("--add-label");
    if (flag >= 0) labels.add(args[flag + 1]);
    return "";
  };
  const parsed = parse("blocked", "460", "the", "spelling", "is", "ambiguous");
  assert.ok("declaration" in parsed);
  const lines = applyBlocked(parsed.declaration, { gh, tracker: "a11ign/agent-org", answerPrefix: ANSWER_PREFIX });
  const wanted = `${ANSWER_PREFIX}${DEFAULT_ANSWERER}`;
  assert.deepEqual([...labels], [wanted], "the label the gate reads as `answer:<session>`");
  assert.deepEqual(calls.map((c) => c.slice(0, 2).join(" ")), ["label create", "issue edit", "issue comment"], "the label exists before it is applied, and the reason is posted");
  assert.ok(calls[2].join(" ").includes("the spelling is ambiguous"), "the comment is the reason");
  assert.match(lines.join("\n"), new RegExp(wanted));

  const dir = dirOf(parsed.declaration, 5);
  const withLabel = { row: rowOf(460, "worker-9", [...labels]), stateDir: dir };
  assert.deepEqual(nudgedAt(withLabel), [], "the row carries the label: an answer is owed, and the worker is not stalled");
  labels.delete(wanted);
  const removed = { row: rowOf(460, "worker-9", [...labels]), stateDir: dir };
  assert.equal(nudgedAt(removed)[0], M, "the same declaration with the label removed: the excuse ended with it");
  const order = tickAt(M, removed, { 460: { session: "worker-9", idleSince: T0 } })[0];
  assert.match(order.prompt, /NO LONGER TRUE/);
});

test("`blocked` whose label GitHub refused writes NOTHING: the exit is 2 and the row is not read as blocked", async () => {
  const dir = scratch("refused-label");
  try {
    const gh = (): string => { throw Object.assign(new Error("HTTP 403"), { stderr: "HTTP 403: forbidden\n" }); };
    const parsed = parse("blocked", "460", "why");
    assert.ok("declaration" in parsed);
    assert.throws(() => applyBlocked(parsed.declaration, { gh, tracker: "a11ign/agent-org", answerPrefix: ANSWER_PREFIX }), /403/);
    assert.deepEqual(readDeclarations(`${dir}/${WORKER_STATE_DIR}`)?.byClaimant.size, 0, "`main` writes only after the label stood, so nothing is on disk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("a bare number that is a row in two trackers is read from the CLAIM: the one carrying this session's label, never the first tracker's", () => {
  const result = resolve("460", BOTH);
  assert.ok("declaration" in result, JSON.stringify(result));
  assert.equal(result.declaration.repo, "a11ign/agent-org");
  assert.equal(result.declaration.rowKey, undefined, "the typed key is resolved away, so the file holds the repository and not the spelling");
});

test("POSITIVE CONTROL: the version this replaces wrote the first tracker's row, closed, which is the row the product-manager was woken on", () => {
  const calls: string[][] = [];
  applyBlocked(blockedOn("460"), { gh: (args) => (calls.push(args), ""), tracker: TRACKERS[0].repo, answerPrefix: ANSWER_PREFIX });
  assert.ok(calls.some((args) => args[0] === "issue" && args.includes("a11ign/a11ign")), "the old call targeted a11ign/a11ign#460");
  const calls2: string[][] = [];
  const result = resolve("460", BOTH);
  assert.ok("declaration" in result);
  applyBlocked(result.declaration, { gh: (args) => (calls2.push(args), ""), tracker: result.declaration.repo as string, answerPrefix: ANSWER_PREFIX });
  assert.ok(calls2.length === 3 && calls2.every((args) => args.includes("a11ign/agent-org") && !args.includes("a11ign/a11ign")), JSON.stringify(calls2));
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

test("no row of that number, and a row that could not be read, are REFUSED by name and neither is read as `closed` or `absent` for the other", () => {
  assert.equal(refusalNamed(resolve("999", {}))?.refused, "no-such-row");
  const throwing = resolveBlockedRow(blockedOn("460"), { trackers: TRACKERS, look: () => { throw new Error("HTTP 502"); }, sessionLabel: CLAIM_LABEL });
  const refusal = refusalNamed(throwing);
  assert.equal(refusal?.refused, "unreadable-row");
  assert.ok(refusal?.why.includes("HTTP 502"), refusal?.why);
});

test("`ghRowLook`: an issue read as its state and labels, no such issue as null, and any other failure thrown", () => {
  const answering = (reply: string | Error) => (): string => { if (reply instanceof Error) throw reply; return reply; };
  assert.deepEqual(ghRowLook(answering('{"state":"CLOSED","labels":[{"name":"x"}]}'))("a11ign/a11ign", 460), { state: "CLOSED", labels: ["x"] });
  assert.deepEqual(ghRowLook(answering('{"state":"OPEN","labels":[]}'))("a11ign/a11ign", 460), { state: "OPEN", labels: [] });
  const missing = Object.assign(new Error("gh failed"), { stderr: "GraphQL: Could not resolve to an Issue with the number of 9999." });
  assert.equal(ghRowLook(answering(missing))("a11ign/a11ign", 9999), null);
  assert.throws(() => ghRowLook(answering(Object.assign(new Error("gh failed"), { stderr: "HTTP 502" })))("a11ign/a11ign", 460), /gh failed/);
});

test("a `blocked` declaration for the row of ANOTHER repository does not excuse this claim (twin: its own repository does)", () => {
  const own = { ...decl({ state: "blocked", pr: undefined, row: 460, to: DEFAULT_ANSWERER }), repo: "a11ign/agent-org" };
  assert.equal(declarationReading(own, ctx({ answersOwed: [DEFAULT_ANSWERER], repo: "a11ign/agent-org" })).kind, "excused");
  assert.equal(declarationReading(own, ctx({ answersOwed: [DEFAULT_ANSWERER], repo: "a11ign/a11ign" })).kind, "lapsed", "row 460 of a11ign/a11ign is another row");
  assert.equal(declarationReading({ ...own, repo: undefined }, ctx({ answersOwed: [DEFAULT_ANSWERER], repo: "a11ign/a11ign" })).kind, "excused", "a declaration written before the repository was recorded is read as before");
});
