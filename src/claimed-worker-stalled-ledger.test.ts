// no-token: gh -- no `gh`, `herdr` or `git` is run; the rows, listing and clock are fixtures and the only files written are in a temporary directory (#4826)
// #4826: THE CLASS `claimed-worker-stalled` IS A NUDGE THE HOLDER DID NOT ANSWER, not every nudge. The ledger used to take one line per FRESH nudge, and
// `repeatsIn` counts two distinct refs under one class as a repeat, so the guard repeated its own class every time it did its job: four nudges on four rows
// (worker-4799, -4808, -4787, -4804, 2026-10-10), every one answered within minutes, tripped `class-repeat`.
//
// THE DETECTOR runs the REAL writer (`claimStallTick` with its own `recordStalledNudges`, over a temporary state directory) and reads the file back through
// `parseFailureLedger` and `repeatsIn`, the pair `class-repeat` itself reads. The second half is the positive control, so the emptiness of the first is not vacuous.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimStallTick } from "./work-gate.ts";
import { claimRecordComment } from "./row-claim.ts";
import { CLAIMED_WORKER_STALLED, STALL_UNTOLD_RELEASE_MS, nudgeKey } from "./claim-stall.ts";
import { FAILURE_LEDGER_FILE, parseFailureLedger, repeatsIn } from "./failure-ledger.ts";
import { STOPPED_CLAIMANT_MINUTES } from "./idle-claimant.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.parse("2026-10-10T09:00:00Z");
const NUDGE_AT = STOPPED_CLAIMANT_MINUTES;
/** One tick after the undelivered nudge's release: the fixture's wake ledger is empty, so the nudge was never delivered and releases after this long. */
const HORIZON = NUDGE_AT + STALL_UNTOLD_RELEASE_MS / MIN + 5;
const AUTHOR = "a11ign-ai-workers";
const STANDING = [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }];
const noGit = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };

/** The four rows of the ledger the row was filed from. */
const ANSWERED_ROWS = [4799, 4808, 4787, 4804];

type Comment = { body: string; createdAt: string; author: { login: string } };
type Holder = { row: number; session: string; comments: Comment[]; status: string };

const holderOf = (row: number): Holder => ({ row, session: `worker-${row}`, status: "idle", comments: [{
  body: claimRecordComment({ session: `worker-${row}`, branch: `agent/x-${row}`, worktree: `../wt-${row}` }),
  createdAt: new Date(T0 - 20 * MIN).toISOString(), author: { login: AUTHOR } }] });

/** How often a resumed holder comments, well inside the 120-minute no-progress clock, so the answered arm is never nudged a SECOND time inside the window. */
const COMMENT_EVERY = 60;

/** The holder resumes: its next turn comments on the row and it is `working` from then on. THE ANSWER the guard exists to get. */
function answer(holder: Holder, minutes: number): void {
  holder.comments.push({ body: "back on it", createdAt: new Date(T0 + minutes * MIN).toISOString(), author: { login: AUTHOR } });
  holder.status = "working";
}

type Order = { session: string; causeKey: string; release?: { why: string } };

/** One tick `minutes` after T0 through the real tick and the real recorder; the nudge memory in `memory` survives between ticks as the state file does. */
function tick(minutes: number, { holders, stateDir, memory }: { holders: Holder[]; stateDir: string; memory: Record<string, unknown> }): Order[] {
  return claimStallTick({
    rows: holders.map((h) => ({ number: h.row, title: `row ${h.row}`, body: "", blockedBy: { nodes: [] },
      labels: ["in-progress", `session:${h.session}`].map((name) => ({ name })) })),
    claimedComments: holders.map((h) => ({ number: h.row, comments: h.comments })),
    openPrs: [], mergedPrs: null, io: noGit, repo: "/repo", now: T0 + minutes * MIN, restartAt: null,
    agents: [...STANDING, ...holders.map((h) => ({ label: h.session, status: h.status }))], stateDir, ledger: () => "", log: () => undefined,
    read: () => JSON.parse(JSON.stringify(memory)),
    write: (_path: string, state: object) => { for (const k of Object.keys(memory)) delete memory[k]; Object.assign(memory, state); },
  } as never) as unknown as Order[];
}

/** Run every minute to `HORIZON`, calling `onMinute` first so a holder can answer at the moment it chooses; returns every order of every tick. */
function runWindow(holders: Holder[], stateDir: string, onMinute: (minutes: number) => void = () => undefined): Order[] {
  const memory: Record<string, unknown> = {};
  const orders: Order[] = [];
  for (let m = 0; m <= HORIZON; m++) {
    onMinute(m);
    orders.push(...tick(m, { holders, stateDir, memory }));
  }
  return orders;
}

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "claimed-worker-stalled-ledger-"));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const entriesIn = (dir: string) => existsSync(join(dir, FAILURE_LEDGER_FILE)) ? parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8")) : [];
const repeatsOf = (dir: string) => repeatsIn(entriesIn(dir), { windowMs: DAY, now: T0 + HORIZON * MIN }).map((r) => [r.classKey, r.refs.length]);

/** Answers two minutes after the nudge and keeps working (commenting) to the end of the window. */
const answersFromNudge = (holders: Holder[]) => (m: number) => {
  if (m >= NUDGE_AT + 2 && (m - NUDGE_AT - 2) % COMMENT_EVERY === 0) holders.forEach((h) => answer(h, m));
};

test("four nudges on four different rows, each ANSWERED, leave NO line in the ledger and NO class repeat", () => withDir((dir) => {
  const holders = ANSWERED_ROWS.map(holderOf);
  const orders = runWindow(holders, dir, answersFromNudge(holders));
  const nudges = new Set(orders.filter((o) => o.release === undefined).map((o) => o.causeKey));
  assert.deepEqual([...nudges].sort(), ANSWERED_ROWS.map((row) => nudgeKey(`worker-${row}`, row, T0 + NUDGE_AT * MIN)).sort(),
    "the control: all four WERE nudged, at the figure, and each nudge is in the wake ledger's key -- nothing the nudge told us is lost");
  assert.deepEqual(orders.filter((o) => o.release !== undefined), [], "and none was released: they answered");
  assert.deepEqual(entriesIn(dir), []);
  assert.deepEqual(repeatsOf(dir), []);
}));

test("two UNANSWERED nudges on two rows ARE a repeat of the class (the positive control of the test above)", () => withDir((dir) => {
  const holders = [4799, 4808].map(holderOf);
  const orders = runWindow(holders, dir);
  assert.deepEqual([...new Set(orders.filter((o) => o.release !== undefined).map((o) => o.session))].sort(), ["worker-4799", "worker-4808"],
    "both claims were released: nothing moved after the nudge");
  assert.deepEqual(entriesIn(dir).map((e) => e.ref).sort(), [`worker-4799/#4799/${T0 + NUDGE_AT * MIN}`, `worker-4808/#4808/${T0 + NUDGE_AT * MIN}`]);
  assert.deepEqual(entriesIn(dir).map((e) => e.classKey), [CLAIMED_WORKER_STALLED, CLAIMED_WORKER_STALLED]);
  assert.deepEqual(repeatsOf(dir), [[CLAIMED_WORKER_STALLED, 2]]);
}));

test("ONE unanswered nudge beside the four answered ones is one event and NOT a repeat; a second unanswered one on the SAME row is a new nudge, so a repeat", () => withDir((dir) => {
  const silent = holderOf(4826);
  const answered = ANSWERED_ROWS.map(holderOf);
  runWindow([...answered, silent], dir, answersFromNudge(answered));
  assert.deepEqual(entriesIn(dir).map((e) => e.ref), [`worker-4826/#4826/${T0 + NUDGE_AT * MIN}`]);
  assert.deepEqual(repeatsOf(dir), [], "one distinct ref is not a repeat: the control for the twin below");
  withDir((again) => {
    const holder = holderOf(4826);
    const memory: Record<string, unknown> = {};
    for (let m = 0; m <= HORIZON; m++) tick(m, { holders: [holder], stateDir: again, memory });
    assert.equal(entriesIn(again).length, 1);
    // The released claim is claimed again by the same session (a spawned engineer's next instance) and stops again: a second nudge, never answered.
    const second = holderOf(4826);
    second.comments[0].createdAt = new Date(T0 + (HORIZON + 1) * MIN).toISOString();
    const memory2: Record<string, unknown> = {};
    for (let m = HORIZON + 2; m <= 2 * HORIZON + 2; m++) tick(m, { holders: [second], stateDir: again, memory: memory2 });
    assert.equal(entriesIn(again).length, 2, "two distinct nudges, both unanswered, are two refs");
    assert.deepEqual(repeatsIn(entriesIn(again), { windowMs: 4 * DAY }).map((r) => [r.classKey, r.refs.length]), [[CLAIMED_WORKER_STALLED, 2]]);
  });
}));
