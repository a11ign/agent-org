// no-token: gh -- every fact here is a fixture; nothing imported reaches `gh`, `git`, the network or a corpus
/**
 * #4637 (class `row-not-finishable`): THE GATE RELEASES A CLAIM THAT REACHES A WAIT IT CANNOT FINISH THROUGH.
 *
 * `worker-3870` held #3870 for a reading due a day later while the gate deferred ready rows for lack of an engineer. A declared wait
 * (a future `Not-before`, another actor's act, another row's result) used to be `waiting` for any holder; it is now `release`, as an open
 * `blockedBy` edge already was, when the holder HOLDS NOTHING.
 *
 * EVERY RELEASE HERE HAS ITS NEGATIVE CONTROL IN THE SAME FIXTURE WITH ONE FACT CHANGED: the held work, the kind of wait or the open pull
 * request. A release that fired for all of them would pass the positive cases and fail those.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimReading, claimStalledOrders, WAIT_RELEASE_KINDS, type ClaimFacts, type Reading } from "./claim-stall.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-09T21:00:00Z");
const CTX = { now: NOW, restartAt: null, nudge: null };
const NOTHING = { state: "none" as const, dirty: 0, unpushed: 0 };

const facts = (over: Partial<ClaimFacts> = {}): ClaimFacts => ({
  row: 3870, session: "worker-3870", claimedAt: NOW - 60 * MIN, branch: "agent/x-3870", worktree: "/w/wt-3870",
  comment: null, commit: null, push: null, file: () => null, work: () => NOTHING, openPrs: 0, mergedPr: null,
  waiting: "waiting until 2026-10-10T19:00:00Z", waitKind: "not-before", blockedBy: [], ...over,
});

const WAITS: [kind: string, phrase: string][] = [
  ["not-before", "not before 2026-10-10T19:00:00Z"],
  ["answer", "an answer from product-manager"],
  ["chairman", "waiting on the chairman (needs:chairman)"],
  ["blocked-by", "waiting for #4000 to close"],
];

test("each wait the holder cannot finish through releases a holder holding nothing, and the release says which wait", () => {
  for (const [waitKind, waiting] of WAITS) {
    const reading = claimReading(facts({ waitKind, waiting }), CTX);
    assert.equal(reading.kind, "release", waitKind);
    assert.deepEqual(reading, { kind: "release", why: "wait", lastMoveAt: null, idleMs: null, nudgedAt: null, waiting }, waitKind);
  }
});

test("the kinds that release are exactly the four, so a new kind of wait must be added here on purpose", () => {
  assert.deepEqual([...WAIT_RELEASE_KINDS].sort(), WAITS.map(([k]) => k).sort());
});

test("NEGATIVE: a holder with unmerged work keeps today's `waiting` reading, whatever the wait (dirty, unpushed, unreadable)", () => {
  const held: [string, ReturnType<ClaimFacts["work"]>][] = [
    ["dirty tree", { state: "at-risk", dirty: 2, unpushed: 0 }],
    ["unpushed commit", { state: "at-risk", dirty: 0, unpushed: 1 }],
    ["tree that cannot be read", { state: "unknown", dirty: 0, unpushed: 0, why: "git exited 128" }],
  ];
  for (const [waitKind, waiting] of WAITS) {
    for (const [what, work] of held) {
      assert.deepEqual(claimReading(facts({ waitKind, waiting, work: () => work }), CTX), { kind: "waiting", waiting }, `${waitKind} + ${what}`);
    }
  }
});

test("NEGATIVE: a holder with an open pull request is pr-owned and is never released for a wait", () => {
  assert.deepEqual(claimReading(facts({ openPrs: 1 }), CTX), { kind: "pr-owned" });
});

test("NEGATIVE: a fleet-hold is the holder's own wait, and a fact built with no kind is not guessed at", () => {
  const fleet = claimReading(facts({ waitKind: "fleet-hold", waiting: "fleet hold until 2026-10-10T19:00:00Z" }), CTX);
  assert.deepEqual(fleet, { kind: "waiting", waiting: "fleet hold until 2026-10-10T19:00:00Z" });
  const { waitKind: _dropped, ...noKind } = facts();
  assert.equal(claimReading(noKind, CTX).kind, "waiting");
  assert.equal(claimReading(facts({ waitKind: null }), CTX).kind, "waiting");
});

test("NEGATIVE: no declared wait is not released by this reading (a moving claim stays moving)", () => {
  const moving = claimReading(facts({ waiting: null, waitKind: null, commit: NOW - 5 * MIN }), CTX);
  assert.equal(moving.kind, "moving");
});

test("NEGATIVE: a claim that names no branch or worktree is held, never released, as for every other release", () => {
  const reading = claimReading(facts({ nothing: true }), CTX);
  assert.equal(reading.kind, "holding");
});

test("the open `blockedBy` edge is still release (8)'s `blocked`, not `wait` (it is read first)", () => {
  const reading = claimReading(facts({ blockedBy: [4000], waitKind: "blocked-by", waiting: "waiting for #4000" }), CTX);
  assert.equal((reading as Extract<Reading, { kind: "release" }>).why, "blocked");
});

test("the release order carries the wait, names it in what the log says, and is the one order for the row", () => {
  const f = facts();
  const reading = claimReading(f, CTX);
  const orders = claimStalledOrders([{ facts: f, reading }], NOW);
  assert.equal(orders.length, 1);
  const [order] = orders;
  assert.equal(order.release?.why, "wait");
  assert.equal(order.release?.waiting, "waiting until 2026-10-10T19:00:00Z");
  assert.equal(order.release?.idleMinutes, null);
  assert.equal(order.causeKey, "worker-3870/claim-stalled/row-3870/release-wait");
  assert.match(order.prompt, /^RELEASE the claim on #3870 held by worker-3870: waiting until 2026-10-10T19:00:00Z, and the holder holds nothing\.$/);
  assert.deepEqual(claimStalledOrders([{ facts: f, reading: claimReading(facts({ work: () => ({ state: "at-risk", dirty: 1, unpushed: 0 }) }), CTX) }], NOW), []);
});
