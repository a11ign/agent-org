// no-token: gh -- no `gh`, `herdr` or `git` is run; the rows, pull requests, listing and clock are fixtures, and the only file written is the failure ledger of a temporary directory (a11ign/agent-org#458)
// #458: a claimed worker that STOPPED mid-task (idle or done, a claim naming a branch, no open pull request, no pending check, no declared wait) is woken with
// "continue" after M minutes, measured on the row; the 45-minute clock stays for everything else. Each nudge appends one `claimed-worker-stalled` event.
//
// EVERY "NOT NUDGED" ASSERTION HAS A TWIN: the same fixture with ONE thing changed that IS nudged (`fixture` below, and each case names its twin), so a decider that
// never fires turns the twins red and one that always fires turns the controls red. The mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimStallTick } from "./work-gate.ts";
import { claimRecordComment } from "./row-claim.ts";
import { CLAIMED_WORKER_STALLED, STALL_INTERVAL_MS, recordStalledNudges, stalledNudgeEvents } from "./claim-stall.ts";
import { FAILURE_LEDGER_FILE, parseFailureLedger, repeatsIn } from "./failure-ledger.ts";
import { WORKER_STATE_DIR, writeDeclaration, type Declaration } from "./worker-state.ts";
import { IDLE_CLAIMANT_MINUTES, STOPPED_CLAIMANT_MINUTES, WAIT_FIELDS, isStoppedHolder, stoppedNudgePrompt } from "./idle-claimant.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-10T09:00:00Z");
const M = STOPPED_CLAIMANT_MINUTES;
const STANDING = [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }];
const listing = (workers: Record<string, string>) => [...STANDING, ...Object.entries(workers).map(([label, status]) => ({ label, status }))];

const noGit = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };
/** The claim record exactly as `row-claim.ts` writes it, made `minutesBefore` T0; young (20 minutes) so the 45-minute no-progress clock is never the cause of a nudge. */
const claimed = (row: number, session: string, { minutesBefore = 20, nothing = null as string | null } = {}) => ({ number: row, comments: [{
  body: claimRecordComment({ session, ...(nothing === null ? { branch: `agent/x-${row}`, worktree: `../wt-${row}` } : { nothing }) }),
  createdAt: new Date(T0 - minutesBefore * MIN).toISOString(), author: { login: "a11ign-ai-workers" } }] });
const rowOf = (number: number, session: string, { body = "", labels = [] as string[] } = {}) => ({ number, title: `row ${number}`, body, blockedBy: { nodes: [] },
  labels: ["in-progress", `session:${session}`, ...labels].map((name) => ({ name })) });
/** An open pull request of the claim's branch. `pending` is a check run still in progress, which the gate reads from the rollup (it recomputes `checksPending` itself). */
const prOf = (row: number, { pending = false } = {}) => ({ number: 9000 + row, headRefName: `agent/x-${row}`, reviewDecision: "REVIEW_REQUIRED", labels: [],
  statusCheckRollup: [pending
    ? { name: "gate", status: "IN_PROGRESS", startedAt: "2026-10-10T08:50:00Z", completedAt: "0001-01-01T00:00:00Z" }
    : { name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-10T08:50:00Z", completedAt: "2026-10-10T08:55:00Z" }] });

type Order = { session: string; cause: string; causeKey: string; prompt: string; release?: { why: string } };
type Fixture = { rows?: ReturnType<typeof rowOf>[]; comments?: ReturnType<typeof claimed>[]; prs?: object[]; workers?: Record<string, string>; stateDir?: string;
  record?: Parameters<typeof claimStallTick>[0]["record"]; log?: string[] };

/** One worker (`worker-9`, row 4001) idle at every tick, a claim with a branch, no pull request, no wait: the case the row names. */
const fixture = (over: Fixture = {}): Required<Pick<Fixture, "rows" | "comments" | "prs" | "workers" | "stateDir">> & Fixture => ({
  rows: [rowOf(4001, "worker-9")], comments: [claimed(4001, "worker-9")], prs: [], workers: { "worker-9": "idle" }, stateDir: "/state", ...over });

/** A tick at `minutes` after T0 over the fixture, with the nudge memory in `memory`, which survives between calls as the state file does. */
function tickAt(minutes: number, f: ReturnType<typeof fixture>, memory: Record<string, unknown>): Order[] {
  const orders = claimStallTick({ rows: f.rows, claimedComments: f.comments, openPrs: f.prs, mergedPrs: null, io: noGit, repo: "/repo",
    now: T0 + minutes * MIN, restartAt: null, agents: listing(f.workers), stateDir: f.stateDir, ledger: () => "", log: (line: string) => f.log?.push(line),
    read: () => JSON.parse(JSON.stringify(memory)), write: (_path: string, state: object) => { for (const k of Object.keys(memory)) delete memory[k]; Object.assign(memory, state); },
    ...(f.record === undefined ? {} : { record: f.record }) } as never) as unknown as Order[];
  return orders.filter((o) => o.release === undefined);
}
/** The minutes, one per tick a minute apart from 0 to `until`, at which this fixture nudges. */
function nudgedAt(f: ReturnType<typeof fixture>, until = 60): number[] {
  const memory: Record<string, unknown> = {};
  const at: number[] = [];
  for (let m = 0; m <= until; m++) if (tickAt(m, f, memory).length > 0) at.push(m);
  return at;
}

test("the figure is the row's: measured, at most 10 minutes, below the 45-minute idle clock, which stays beside the 120-minute no-progress clock", () => {
  assert.equal(M, 10);
  assert.ok(M <= 10 && M < IDLE_CLAIMANT_MINUTES);
  assert.equal(IDLE_CLAIMANT_MINUTES, 45, "N is untouched");
  assert.equal(STALL_INTERVAL_MS, 120 * MIN, "and so is the no-progress clock");
});

test("a claimed worker idle for two ticks with no PR and no wait field is nudged AT the figure and not before", () => {
  const memory: Record<string, unknown> = {};
  const f = fixture();
  assert.deepEqual(tickAt(0, f, memory), [], "the first idle tick only starts the clock");
  assert.deepEqual(memory[4001], { session: "worker-9", idleSince: T0 }, "and remembers it, which is the second tick's evidence");
  for (let m = 1; m < M; m++) assert.deepEqual(tickAt(m, f, memory), [], `${m} minutes idle: not yet`);
  const [order] = tickAt(M, f, memory);
  assert.equal(order.cause, "claim-stalled");
  assert.equal(order.session, "worker-9");
  assert.match(order.prompt, /CONTINUE NOW/);
  assert.match(order.prompt, /YOU STOPPED MID-TASK/);
});

test("twin of the above: nothing before two ticks -- an idle worker seen ONCE, long after its claim, is not nudged", () => {
  assert.deepEqual(tickAt(M + 30, fixture(), {}), [], "no idle run behind this reading: it starts the clock");
  assert.equal(nudgedAt(fixture(), M + 5)[0], M, "the control: the same worker ticked every minute is nudged at M");
});

test("`done` is as stopped as `idle`; `blocked`, `unknown` and a partial listing are not read as stopped (twin: idle)", () => {
  assert.equal(nudgedAt(fixture({ workers: { "worker-9": "done" } }), M + 5)[0], M);
  assert.deepEqual(nudgedAt(fixture({ workers: { "worker-9": "blocked" } }), M + 5), []);
  assert.deepEqual(nudgedAt(fixture({ workers: { "worker-9": "unknown" } }), M + 5), []);
  const partial = fixture();
  const orders = claimStallTick({ rows: partial.rows, claimedComments: partial.comments, openPrs: [], mergedPrs: null, io: noGit, repo: "/repo", now: T0 + M * MIN,
    restartAt: null, agents: [{ label: "worker-9", status: "idle" }], stateDir: "/state", ledger: () => "", log: () => undefined,
    read: () => ({ 4001: { session: "worker-9", idleSince: T0 } }), write: () => undefined } as never) as unknown as Order[];
  assert.deepEqual(orders.filter((o) => o.release === undefined), [], "a listing that lacks the standing panes is not the whole org");
});

/** A state directory holding `worker-9`'s declaration, made `minutesBefore` T0 (the claim is 20 minutes old, so 5 is a declaration made after it). */
function declaredIn(declaration: Omit<Declaration, "session" | "at">, { minutesBefore = 5 } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "idle-claimant-stopped-declared-"));
  writeDeclaration(`${dir}/${WORKER_STATE_DIR}`, { session: "worker-9", at: T0 - minutesBefore * MIN, ...declaration });
  return dir;
}

test("NEGATIVE CONTROL (#460): an open PR with a pending check excuses the worker only when it DECLARED `waiting-ci` for it; the twins are nudged at M", () => {
  const pr = prOf(4001, { pending: true });
  const waiting = declaredIn({ state: "waiting-ci", pr: { number: pr.number } });
  const declaredNothing = fixture({ prs: [pr] });
  try {
    assert.deepEqual(nudgedAt(fixture({ prs: [pr], stateDir: waiting }), 60), [], "declared, still pending: the wait the worker named");
    assert.equal(nudgedAt(declaredNothing, 60)[0], M, "the same pending PR with nothing declared is no longer read as a wait: it is stalled at M, not at the 45-minute clock");
    assert.equal(nudgedAt(fixture({ prs: [prOf(4001)], stateDir: waiting }), 60)[0], M, "the declaration outlives its condition: the check finished, so `waiting-ci` is not true any more");
  } finally {
    rmSync(waiting, { recursive: true, force: true });
  }
  assert.deepEqual(nudgedAt(fixture(), 60).slice(0, 1), [M], "and the no-PR twin of all of them is nudged at M");
});

test("REGIME OFF: a state directory that cannot be READ (not merely empty) leaves the 45-minute rules in force, because absence is not proof", () => {
  const unreadable = mkdtempSync(join(tmpdir(), "idle-claimant-stopped-unreadable-"));
  writeFileSync(`${unreadable}/${WORKER_STATE_DIR}`, "a file where the directory should be");
  try {
    assert.deepEqual(nudgedAt(fixture({ prs: [prOf(4001, { pending: true })], stateDir: unreadable }), 60), [], "could not ask: a pending check is a wait, as before");
    assert.equal(nudgedAt(fixture({ prs: [prOf(4001)], stateDir: unreadable }), 60)[0], IDLE_CLAIMANT_MINUTES, "and a PR is on N, as before");
  } finally {
    rmSync(unreadable, { recursive: true, force: true });
  }
});

test("a `working` worker is NOT nudged, however long; the twin is the same worker idle", () => {
  assert.deepEqual(nudgedAt(fixture({ workers: { "worker-9": "working" } }), 60), []);
  assert.equal(nudgedAt(fixture(), 60)[0], M);
});

test("a declared wait field clears it: every row field in idle-claimant's own table (twin: no field)", () => {
  const rowKinds = Object.entries(WAIT_FIELDS).filter(([, field]) => field.on === "row").map(([kind]) => kind);
  assert.ok(rowKinds.length >= 5, "the table has its row kinds, so this is not an empty loop");
  const waiting = [
    fixture({ rows: [rowOf(4001, "worker-9", { body: "Not-before: 2099-01-01" })] }),
    fixture({ rows: [rowOf(4001, "worker-9", { labels: ["needs:chairman"] })] }),
    fixture({ rows: [rowOf(4001, "worker-9", { labels: ["answer:product-manager"] })] }),
  ];
  for (const f of waiting) assert.deepEqual(nudgedAt(f, 60), [], JSON.stringify(f.rows[0].labels));
  assert.equal(nudgedAt(fixture(), 60)[0], M, "the control: the same row with none");
});

test("a `Claimed-nothing:` claim is not on the stopped clock (it is idle at its prompt by design); the twin names a branch", () => {
  const nothing = fixture({ comments: [claimed(4001, "worker-9", { nothing: "reading, no git object" })] });
  assert.deepEqual(nudgedAt(nothing, M + 5), []);
  assert.equal(nudgedAt(fixture(), M + 5)[0], M);
});

test("the no-progress clock stays: a `working` holder whose claim moved nothing for 120 minutes is nudged by it, in its own words; at 100 it is not (twin)", () => {
  const stale = (minutesBefore: number) => fixture({ comments: [claimed(4001, "worker-9", { minutesBefore })], workers: { "worker-9": "working" } });
  const orders = tickAt(0, stale(STALL_INTERVAL_MS / MIN + 10), {});
  assert.equal(orders.length, 1, "nothing moved for longer than the interval: nudged by the clock, not by the stopped figure");
  assert.doesNotMatch(orders[0].prompt, /YOU STOPPED MID-TASK/);
  assert.deepEqual(tickAt(0, stale(100), {}), [], "the control: the same holder inside the interval");
});

test("the order is told apart by its facts: isStoppedHolder is the one definition the reading and the text both ask", () => {
  assert.equal(isStoppedHolder({ built: true, prs: [] }), true);
  assert.equal(isStoppedHolder({ built: true }), true);
  assert.equal(isStoppedHolder({ built: true, prs: [{ number: 1 }] as never }), false);
  assert.equal(isStoppedHolder({ built: false, prs: [] }), false);
  assert.equal(isStoppedHolder({ prs: [] }), false, "a caller that does not say is N's, as it was");
  const text = stoppedNudgePrompt({ row: 4001, branch: "agent/x-4001", idleMinutes: 10, releaseMinutes: 45, canRelease: true });
  for (const field of Object.values(WAIT_FIELDS).filter((w) => w.on === "row")) assert.ok(text.includes(field.spelling), `spells ${field.spelling}`);
  assert.match(text, /RELEASED/);
  assert.doesNotMatch(stoppedNudgePrompt({ row: 4001, branch: null, idleMinutes: 10, releaseMinutes: 45, canRelease: false }), /RELEASED/);
});

// --- the failure ledger: ONE `claimed-worker-stalled` line per nudge ---------------------------------------------------------------

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "idle-claimant-stopped-"));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const ledgerOf = (dir: string) => parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8"));

test("each nudge appends one `claimed-worker-stalled` line, ref `<session>/#<row>/<nudge time>`; the same episode seen again appends none", () => withDir((dir) => {
  const f = fixture({ stateDir: dir });
  const memory: Record<string, unknown> = {};
  for (let m = 0; m < M; m++) tickAt(m, f, memory);
  assert.throws(() => readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8"), /ENOENT/, "nothing before the nudge: no event for a worker that is only idle");
  assert.equal(tickAt(M, f, memory).length, 1);
  assert.deepEqual(ledgerOf(dir), [{ classKey: CLAIMED_WORKER_STALLED, at: T0 + M * MIN, ref: `worker-9/#4001/${T0 + M * MIN}` }]);
  tickAt(M + 1, f, memory);
  tickAt(M + 2, f, memory);
  assert.equal(ledgerOf(dir).length, 1, "the following ticks read `nudged`: the same episode is not a second event");
}));

test("two nudges for different rows read back as ONE repeat of the class through `repeatsIn`; one nudge alone is not (twin)", () => withDir((dir) => {
  const two = fixture({ stateDir: dir, rows: [rowOf(4001, "worker-9"), rowOf(4002, "worker-10")], comments: [claimed(4001, "worker-9"), claimed(4002, "worker-10")],
    workers: { "worker-9": "idle", "worker-10": "idle" } });
  const memory: Record<string, unknown> = {};
  for (let m = 0; m <= M; m++) tickAt(m, two, memory);
  const entries = ledgerOf(dir);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.ref).sort(), [`worker-10/#4002/${T0 + M * MIN}`, `worker-9/#4001/${T0 + M * MIN}`]);
  assert.deepEqual(repeatsIn(entries, { windowMs: 24 * 60 * MIN }).map((r) => [r.classKey, r.refs.length]), [[CLAIMED_WORKER_STALLED, 2]]);
  assert.deepEqual(repeatsIn(entries.slice(0, 1), { windowMs: 24 * 60 * MIN }), [], "the control: one nudge is an event and not a repeat");
}));

test("a nudge of the 45-minute clock (a PR holder) is a stall nudge too and is recorded; a release and a `working` tick are not", () => withDir((dir) => {
  const memory: Record<string, unknown> = {};
  const pr = fixture({ stateDir: dir, prs: [prOf(4001)] });
  for (let m = 0; m <= IDLE_CLAIMANT_MINUTES; m++) tickAt(m, pr, memory);
  assert.equal(ledgerOf(dir).length, 1);
  withDir((other) => {
    const working = fixture({ stateDir: other, workers: { "worker-9": "working" } });
    const mem: Record<string, unknown> = {};
    for (let m = 0; m <= M + 5; m++) tickAt(m, working, mem);
    assert.throws(() => readFileSync(join(other, FAILURE_LEDGER_FILE), "utf8"), /ENOENT/);
  });
}));

// --- a recorder never throws into the tick, and a refused append is reported -------------------------------------------------------

test("a refused append is REPORTED and does not throw out of the tick: the nudge is still ordered", () => withDir((dir) => {
  mkdirSync(join(dir, FAILURE_LEDGER_FILE)); // a directory where the file should be: the append (and the read of what is logged) is refused
  const reported: string[] = [];
  const f = fixture({ stateDir: dir, log: [], record: (tick) => recordStalledNudges({ ...tick, report: (line) => reported.push(line) }) });
  const memory: Record<string, unknown> = {};
  for (let m = 0; m < M; m++) tickAt(m, f, memory);
  const orders = tickAt(M, f, memory);
  assert.equal(orders.length, 1, "the order the tick exists to send is not lost to the recorder");
  assert.ok(reported.some((line) => line.includes("NOT RECORDED") && line.includes(`worker-9/#4001/${T0 + M * MIN}`)), `the refusal is said: ${JSON.stringify(reported)}`);
}));

test("a recorder that itself throws is caught by recordStalledNudges and said (the twin is the same call with a working recorder)", () => {
  const readings = [{ facts: { session: "worker-9", row: 4001 }, reading: { kind: "nudge" } }] as never;
  const said: string[] = [];
  const result = recordStalledNudges({ readings, now: T0, logPath: "/nowhere/x", report: (line) => said.push(line), record: () => { throw new Error("disk is on fire\nsecond line"); } });
  assert.deepEqual({ appended: result.appended, refused: result.refused }, { appended: 0, refused: "disk is on fire" });
  assert.equal(said.length, 1);
  assert.match(said[0], /NOT RECORDED: disk is on fire/);
  const appended: string[] = [];
  const fine = recordStalledNudges({ readings, now: T0, logPath: "/nowhere/x", report: () => undefined,
    record: ({ events }) => { appended.push(...events.map((e) => e.ref)); return { appended: events.length, skipped: 0, refused: null }; } });
  assert.equal(fine.appended, 1);
  assert.deepEqual(appended, [`worker-9/#4001/${T0}`]);
});

test("only a FRESH nudge is an event: `nudged`, `release`, `moving` and `idle-watch` readings make none", () => {
  const facts = { session: "worker-9", row: 4001 };
  const kinds = [{ kind: "nudge" }, { kind: "nudged" }, { kind: "release" }, { kind: "moving" }, { kind: "idle-watch" }, { kind: "pr-owned" }, { kind: "waiting" }];
  const events = stalledNudgeEvents(kinds.map((reading) => ({ facts, reading })) as never, T0);
  assert.deepEqual(events, [{ classKey: CLAIMED_WORKER_STALLED, ref: `worker-9/#4001/${T0}`, at: T0 }]);
  assert.deepEqual(stalledNudgeEvents(undefined, T0), []);
});
