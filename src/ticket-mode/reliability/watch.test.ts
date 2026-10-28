// no-token: none -- pure
// A11-366: what a reliability watch does as its ticket closes, its fix is installed and its figure is read
import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, newWatch, owesReopen, reopened, reopenStepDone, type Facts, type Watch } from "./watch.ts";

const SPEC = { figure: "sync-holds", threshold: 10, windowMs: 1000 } as const;
const base: Watch = newWatch({ key: "A11-1", title: "t", url: null, origin: "ticket" }, SPEC);
const facts = (over: Partial<Facts> & { value?: number } = {}): Facts => {
  const { value, ...rest } = over;
  return { now: 100, completed: true, installed: true, read: value === undefined ? null : { value, readings: { at: 100, lines: [`synchronous holds ${value} an hour`] } }, ...rest };
};

test("a watch waits for its ticket to be completed, then for the fix to be installed, and only then begins its window", () => {
  assert.equal(advance(base, facts({ completed: false, value: 99 })).state, "open");
  const closed = advance(base, facts({ installed: false, value: 99 }));
  assert.deepEqual([closed.state, closed.closedAt, closed.began, closed.reads], ["watching", 100, undefined, 0], "a figure of the week before the fix reaches this host says nothing of it");
  const begun = advance(closed, facts({ now: 200, value: 3 }));
  assert.deepEqual([begun.began, begun.reads, begun.last?.value], [200, 1, 3]);
});

test("the first reading at the threshold breaches, with the readings, and a window that closes under it holds", () => {
  const begun = advance(base, facts({ value: 3 }));
  const breached = advance(begun, facts({ now: 150, value: 10 }));
  assert.deepEqual([breached.state, breached.breach?.reading, breached.breach?.readings.lines], ["breached", { at: 150, value: 10 }, ["synchronous holds 10 an hour"]]);
  assert.equal(advance(begun, facts({ now: 1099, value: 9 })).state, "watching");
  assert.equal(advance(begun, facts({ now: 1100, value: 9 })).state, "held");
  assert.equal(advance(begun, facts({ now: 1100 })).state, "watching", "a window cannot close clean on a figure the board did not read");
});

test("a tracker that cannot say whether the ticket is completed changes nothing", () => {
  const begun = advance(base, facts({ value: 3 }));
  assert.equal(advance(begun, facts({ completed: null, value: 50 })), begun);
});

test("a ticket put back to work is no longer the watch's: it starts over at its next close", () => {
  const begun = advance(base, facts({ value: 3 }));
  const atWork = advance(begun, facts({ now: 300, completed: false }));
  assert.deepEqual([atWork.state, atWork.began, atWork.reads], ["open", undefined, 0]);
  const again = advance(atWork, facts({ now: 400, value: 1 }));
  assert.deepEqual([again.state, again.closedAt, again.began, again.reads], ["watching", 400, 400, 1]);
});

test("a held watch stays held while the ticket stays completed", () => {
  const held = advance(advance(base, facts({ value: 3 })), facts({ now: 5000, value: 3 }));
  assert.equal(held.state, "held");
  assert.equal(advance(held, facts({ now: 6000, value: 99 })), held);
});

test("a breached watch is the board's to finish, and a reopen done in steps is not forgotten when the ticket has left completed", () => {
  const breached = advance(advance(base, facts({ value: 3 })), facts({ now: 150, value: 12 }));
  assert.equal(advance(breached, facts({ completed: false })), breached);
  const moved = reopened(breached, 160);
  assert.deepEqual([moved.state, moved.reopens, owesReopen(moved)], ["reopened", 1, true]);
  assert.equal(advance(moved, facts({ completed: false })), moved, "its comment and its place on the queue are still owed");
  const done = reopenStepDone(reopenStepDone(moved, "commented"), "queued");
  assert.equal(owesReopen(done), false);
  const atWork = advance(done, facts({ now: 400, completed: false }));
  assert.deepEqual([atWork.state, atWork.reopens], ["open", 1]);
});

test("a watch with no figure follows its ticket and never breaches", () => {
  const unmeasured = newWatch({ key: "A11-2", title: "t", url: null, origin: "ticket" }, null, "its Done-when has no `Figure:` line");
  const closed = advance(unmeasured, facts({ value: 99 }));
  assert.deepEqual([closed.state, closed.reads], ["watching", 0]);
});
