// no-token: gh -- the queue's view, in memory; nothing is read or spawned
// A11-347: a ticket In Progress with no run that holds queued runs back is completed when its pull requests all merged and one closes it, and queued otherwise; the sentence says which
import { test } from "node:test";
import assert from "node:assert/strict";
import { idleBlockerOf, idleBlockers, idleWords } from "./idle-blocker.ts";
import { holderMove } from "./long-waits.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

const PULL = (n: number): string => `https://github.com/a11ign/agent-org/pull/${n}`;
const entry = (key: string, over: Record<string, unknown> = {}) => ({ ticket: { key }, phase: "queued", ...over }) as unknown as ViewEntry;
const blocker = (over: Record<string, unknown> = {}) => ({ key: "A11-253", state: "started", status: "In Progress", pulls: {}, ...over });
const merged = (...numbers: number[]) => Object.fromEntries(numbers.map((n) => [PULL(n), "merged"]));
const declared = (...kinds: ("closes" | "none" | "partial")[]) => Object.fromEntries(kinds.map((kind, at) => [PULL(at + 1), kind === "partial" ? { kind, remains: "step 1 of 2" } : { kind }]));
const waiter = (over: Record<string, unknown> = {}, key = "A11-254") => entry(key, { blockers: [blocker({ pulls: merged(1, 2) })], ...over });

test("A11-347: a ticket In Progress with no run, whose pull requests have all merged and one of them closes it, is completed", () => {
  const board = [waiter({ blockersDeclared: declared("none", "closes") })];
  assert.deepEqual(idleBlockerOf("A11-253", board), { key: "A11-253", action: "complete", blocks: ["A11-254"], pulls: 2, merged: [PULL(1), PULL(2)] });
});

test("A11-347: a ticket with open work and no run that holds a queued run back is queued: a Partial: merge with nothing following it, an open pull request, or no pull request at all", () => {
  const partial = [waiter({ blockersDeclared: declared("none", "partial") })];
  assert.equal(idleBlockerOf("A11-253", partial)?.action, "queue", "a merged Partial: and no closing pull request");
  const open = [waiter({ blockers: [blocker({ pulls: { ...merged(1), [PULL(2)]: "open" } })], blockersDeclared: declared("closes") })];
  assert.equal(idleBlockerOf("A11-253", open)?.action, "queue", "a pull request still open holds it, though another closed");
  const none = [waiter({ blockers: [blocker()] })];
  assert.equal(idleBlockerOf("A11-253", none)?.action, "queue", "a ticket nobody has opened a pull request for");
  const ended = [waiter({ blockers: [blocker({ pulls: { ...merged(1), [PULL(2)]: "closed" } })], blockersDeclared: declared("closes") })];
  assert.equal(idleBlockerOf("A11-253", ended)?.action, undefined, "a closed pull request is not a merge: it is not completed, and it holds nothing here");
});

test("A11-347: the bodies of its merged pull requests are read before the board acts", () => {
  assert.equal(idleBlockerOf("A11-253", [waiter({ blockersDeclared: { [PULL(1)]: { kind: "closes" } } })])?.action, "read");
  assert.equal(idleBlockerOf("A11-253", [waiter()])?.action, "read");
});

test("A11-347: a ticket the board takes no action on: it has a run, it is not In Progress, or no queued run is sequenced behind it", () => {
  const board = [waiter({ blockersDeclared: declared("none", "closes") })];
  assert.equal(idleBlockerOf("A11-253", [...board, entry("A11-253", { phase: "finished" })]) === null, true, "a finished run is a run");
  assert.equal(idleBlockerOf("A11-253", [waiter({ blockers: [blocker({ state: "unstarted", status: "Todo" })] })]) === null, true, "a ticket nobody started is not taken up on a dependent's word");
  assert.equal(idleBlockerOf("A11-253", [{ ...board[0]!, phase: "running" } as ViewEntry]) === null, true, "a run that has started waits on nothing");
  assert.equal(idleBlockerOf("A11-253", [entry("A11-254")]) === null, true);
});

test("A11-347: every idle blocker is listed once, however many queued runs it holds back", () => {
  const board = [waiter({ blockersDeclared: declared("none", "closes") }), waiter({ blockersDeclared: declared("none", "closes") }, "A11-256")];
  assert.deepEqual(idleBlockers(board).map(({ key, blocks }) => [key, blocks]), [["A11-253", ["A11-254", "A11-256"]]]);
});

test("A11-347: the sentence on the wait names the action the board takes, and for a ticket it takes none on, that a person decides", () => {
  const closing = [waiter({ blockersDeclared: declared("none", "closes") })];
  assert.equal(holderMove("A11-253", closing).words, "A11-253 has no run on the board and all 2 of its pull requests have merged, one of them closing it, so the board completes it on its next sweep");
  const partial = [waiter({ blockersDeclared: declared("none", "partial") })];
  assert.equal(holderMove("A11-253", partial).words, "A11-253 has no run on the board and still has open work, so the board queues it on the saved model on its next sweep");
  assert.match(holderMove("A11-253", [waiter()]).words, /the board is reading its merged pull requests before it completes or queues it$/);
  const todo = [waiter({ blockers: [blocker({ state: "unstarted" })] })];
  assert.equal(holderMove("A11-253", todo).words, idleWords("A11-253", idleBlockerOf("A11-253", todo)));
  assert.match(holderMove("A11-253", todo).words, /a person queues it or lifts the block$/);
  assert.deepEqual([holderMove("A11-253", closing).moves, holderMove("A11-253", todo).moves], [true, false]);
});
