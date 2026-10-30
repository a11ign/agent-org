// no-token: none -- the cards' words for a blocker whose run crashed, in memory
// A11-399: A11-231 crashed on the network three times and stayed crashed; A11-232, blocked on it, read as an ordinary wait for a partial merge. A crashed blocker is said on its card and on the cards waiting on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crashedHoldsNote, crashedRunOf } from "./crashed-blockers.ts";
import { waitNote, waitsOn } from "./pull-status-and-notes.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

const AT = Date.UTC(2026, 9, 30, 12, 0);
const PULL = "https://github.com/a11ign/announcement-emulator/pull/19";
const crashed = (key: string, over: Record<string, unknown> = {}) => ({ ticket: { key }, phase: "finished", outcome: { kind: "crashed", reason: "fetch failed (ECONNRESET)" }, finishedAt: AT, ...over }) as unknown as ViewEntry;
/** A11-232 queued behind A11-231, whose step 1 merged and declared itself partial (announcement-emulator#19). */
const behind = (over: Record<string, unknown> = {}) => ({
  ticket: { key: "A11-232" }, phase: "queued",
  blockers: [{ key: "A11-231", state: "started", status: "In Progress", pulls: { [PULL]: "merged" } }],
  blockersDeclared: { [PULL]: [{ kind: "partial", remains: "step 2 of 2: the rest" }] }, ...over,
}) as unknown as ViewEntry;

test("a crashed run of a ticket is found, and a ticket with a run at work has none", () => {
  const dead = crashed("A11-231");
  assert.equal(crashedRunOf("A11-231", [dead, behind()]), dead);
  assert.equal(crashedRunOf("A11-232", [dead, behind()]), null, "a queued run is no crashed one");
  assert.equal(crashedRunOf("A11-231", [dead, { ticket: { key: "A11-231" }, phase: "queued" } as unknown as ViewEntry]), null, "a live run of the ticket takes precedence");
  assert.equal(crashedRunOf("A11-231", [crashed("A11-231", { workspace: "w1" })]), null, "a crashed run still holding its workspace is parked, which is at work");
  assert.equal(crashedRunOf("A11-231", [{ ticket: { key: "A11-231" }, phase: "finished", outcome: { kind: "checked" } } as unknown as ViewEntry]), null);
});

test("a ticket blocked on a crashed run says so, never a wait for the partial merge (A11-231, A11-232)", () => {
  assert.equal(waitNote(behind(), [crashed("A11-231"), behind()]), "Waits on A11-231, which crashed");
  assert.equal(waitNote(behind(), [{ ticket: { key: "A11-231" }, phase: "running" } as unknown as ViewEntry, behind()]), "Waits for A11-231 (running)", "with a live run its wording is today's");
});

test("a blocker the planner said to wait for to merge reads crashed too, and not as a wait to merge", () => {
  const waiting = behind({ waitMerged: ["A11-231"] });
  assert.equal(waitNote(waiting, [crashed("A11-231"), waiting]), "Waits on A11-231, which crashed");
});

test("a crashed blocker that was canceled, or that the worker stopped for, keeps its own words", () => {
  const canceled = behind({ blockers: [{ key: "A11-231", state: "canceled", status: "Canceled" }], blockersDeclared: undefined });
  assert.equal(waitNote(canceled, [crashed("A11-231"), canceled]), "A11-231 was canceled: a person decides");
  const mixed = behind({ blockers: [{ key: "A11-231", state: "canceled", status: "Canceled" }, { key: "A11-240", state: "started", status: "In Progress" }], waitMerged: ["A11-240"], blockersDeclared: undefined });
  assert.equal(waitNote(mixed, [crashed("A11-231"), mixed]), "Waits for A11-240 to merge", "a canceled blocker is not said to have crashed beside a wait to merge");
  const stopped = behind({ stoppedForBlocker: { at: AT, keys: ["A11-231"] } });
  assert.equal(waitNote(stopped, [crashed("A11-231"), stopped]), "Waits for A11-231 to be done: its worker waits on it");
});

test("a crashed blocker whose pull requests all merged and are not partial lets the blocked ticket go", () => {
  const closed = behind({ blockersDeclared: { [PULL]: [{ kind: "closes" }] } });
  assert.deepEqual(waitsOn(closed, [crashed("A11-231"), closed]), []);
  assert.equal(waitNote(closed, [crashed("A11-231"), closed]), null);
});

test("a crashed blocker with no pull request is said the same way", () => {
  const unmerged = behind({ blockers: [{ key: "A11-231", state: "started", status: "In Progress" }], blockersDeclared: undefined });
  assert.equal(waitNote(unmerged, [crashed("A11-231"), unmerged]), "Waits on A11-231, which crashed");
});

test("the crashed run's card names the tickets waiting on it and says what the board does next", () => {
  const retrying = (crashRetry: Record<string, unknown>) => crashed("A11-231", { crashRetry });
  const notBefore = AT + 30 * 60_000;
  assert.equal(crashedHoldsNote(retrying({ count: 2, recovery: { notBefore, restarts: [] } }), ["A11-232"], AT), "A11-232 waits on A11-231, which crashed; the board starts it again once its network calls succeed, not before 12:30Z");
  assert.equal(crashedHoldsNote(retrying({ count: 2, recovery: { notBefore, restarts: [] } }), ["A11-232", "A11-240"], AT), "A11-232 and A11-240 wait on A11-231, which crashed; the board starts it again once its network calls succeed, not before 12:30Z");
  assert.equal(crashedHoldsNote(retrying({ count: 2, recovery: { notBefore, restarts: [] } }), ["A11-232", "A11-240", "A11-241"], AT)?.slice(0, 55), "A11-232, A11-240 and A11-241 wait on A11-231, which cra");
  assert.equal(crashedHoldsNote(crashed("A11-231"), ["A11-232"], AT), "A11-232 waits on A11-231, which crashed; a person retries it");
  assert.equal(crashedHoldsNote(retrying({ count: 2 }), ["A11-232"], AT), "A11-232 waits on A11-231, which crashed; a person retries it", "a count with no recovery mark is a person's");
  assert.equal(crashedHoldsNote(retrying({ count: 1, retryAt: AT + 60_000 }), ["A11-232"], AT), "A11-232 waits on A11-231, which crashed; the board starts it again at 12:01Z");
});

test("past the day's bound the crashed run's card says how many restarts there were and when the next may come", () => {
  const restarts = [AT - 20 * 3_600_000, AT - 10 * 3_600_000, AT - 3_600_000];
  const run = crashed("A11-231", { crashRetry: { count: 2, recovery: { notBefore: AT - 60_000, restarts } } });
  assert.equal(crashedHoldsNote(run, ["A11-232"], AT), "A11-232 waits on A11-231, which crashed; the board has restarted it 3 times today and starts it again after 16:00Z");
});

test("a crashed run nothing waits on has no line", () => {
  assert.equal(crashedHoldsNote(crashed("A11-231"), [], AT), null);
});
