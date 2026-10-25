// no-token: gh -- the pool over the fake code host: a stack world is seeded in memory, and the member is closed only through the fake's `closePull`
// module: the board closes a member of a stack that holds nothing of its own once the member below it merged and `main` was merged into it (A11-248)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost, fakePullUrl } from "../plugins/fakes/code-host.ts";
import type { CodeHost } from "../plugins/contracts/code-host.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { poolFixture } from "./pool-fixture.ts";

const REPOSITORY = "a11ign/agent-org";
const BOTTOM = fakePullUrl(REPOSITORY, 1);
const NEXT = fakePullUrl(REPOSITORY, 2);
const BOTTOM_BRANCH = "a11-1-the-bottom-member";
const NEXT_BRANCH = "a11-2-the-next-member";
const NEXT_HEAD = "b".repeat(40);
const MERGED_IN_HEAD = "c".repeat(40);
const NOW = 1_000_000;
const RESTACKED = "#2 restacked on main after #1 merged";
const CLOSED = "#2 closed: everything it held merged with #1";

const bottomRun = (): Entry => ({ ticket: { key: "A11-1" }, phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: BOTTOM }] }, pullStates: { [BOTTOM]: "merged" } }) as unknown as Entry;

/** The run of the next member: finished, stacked on A11-1's branch, its pull request open. */
const nextRun = (over: Record<string, unknown> = {}): Entry => ({
  ticket: { key: "A11-2", branch: "a11-2-work" }, phase: "finished", finishedAt: NOW / 2, outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: NEXT }] }, pullStates: { [NEXT]: "open" },
  blockers: [{ key: "A11-1", state: "started", status: "In Review", branch: BOTTOM_BRANCH, pulls: {} }],
  stackBase: { key: "A11-1", repo: "agent-org", branch: BOTTOM_BRANCH, sha: "d".repeat(40) }, ...over,
}) as unknown as Entry;

/**
 * A stack of #1 (merged into `main`) and #2 above it, with a run for each. #2 starts with a file of its own. `restacked` moves it through the sweep that restacks it, and `emptied` is what the merge of `main` leaves it: no file of its own, at a new head,
 * as GitHub reads a pull request whose work merged below it.
 */
function world(over: { codeHost?: (host: ReturnType<typeof createFakeCodeHost>) => CodeHost; next?: Record<string, unknown> } = {}) {
  const host = createFakeCodeHost("worker-bot");
  host.seedPull(REPOSITORY, 1, { head: BOTTOM_BRANCH, state: "merged" });
  host.seedPull(REPOSITORY, 2, { head: NEXT_BRANCH, base: BOTTOM_BRANCH, files: [".acceptance/admin~a11-2.md", "src/the-next-member.ts"] });
  host.pullAt(NEXT)!.head = NEXT_HEAD;
  const fixture = poolFixture({ keys: ["A11-2"], now: () => NOW });
  fixture.store.set({ ...fixture.store.get(), entries: [bottomRun(), nextRun(over.next)] });
  const pool = fixture.restart({ codeHost: over.codeHost?.(host) ?? host });
  const next = () => fixture.store.get().entries.find((entry) => entry.ticket.key === "A11-2")!;
  const reads = () => host.calls.filter((call) => call === `readPullFeedback ${NEXT}`).length;
  const closes = () => host.calls.filter((call) => call === `closePull ${NEXT}`).length;
  /** The sweep that restacks the member, and the merge of `main` into it that moves its head. */
  const restacked = () => {
    pool.retargetStacked();
    assert.equal(next().retargets![NEXT], RESTACKED, "the first sweep restacks it");
    host.pullAt(NEXT)!.head = MERGED_IN_HEAD;
  };
  const emptied = () => { host.pullAt(NEXT)!.files = [".acceptance/admin~a11-2.md"]; };
  return { host, pool, next, reads, closes, restacked, emptied, fixture };
}

test("A11-248: an empty member is closed with a comment, the card says so, and a further sweep closes nothing again", () => {
  const { host, pool, next, closes, restacked, emptied } = world();
  restacked();
  assert.equal(closes(), 0, "the sweep that restacked it did not close it");
  emptied();
  pool.retargetStacked();
  assert.deepEqual(host.closes.closed, [{ url: NEXT, comment: "Closed by agent-org: everything #2 held merged with #1, so it has no changes of its own left." }]);
  assert.equal(host.readPullState(NEXT), "CLOSED");
  assert.equal(next().retargets![NEXT], CLOSED);
  pool.retargetStacked();
  assert.equal(closes(), 1, "one close in all");
  assert.equal(next().retargets![NEXT], CLOSED, "and the note stays while the pull request is listed");
});

test("A11-248: a read at the head the restack was made at is not trusted, but the same head is after the branch was found up to date", () => {
  const stale = world();
  stale.restacked();
  stale.host.pullAt(NEXT)!.head = NEXT_HEAD;
  stale.emptied();
  stale.pool.retargetStacked();
  assert.equal(stale.closes(), 0, "a stale read right after the merge");
  assert.equal(stale.next().retargets![NEXT], RESTACKED);
  const current = world();
  current.host.branchUpdates.answers.set(NEXT, { kind: "up-to-date" });
  current.pool.retargetStacked();
  current.emptied();
  current.pool.retargetStacked();
  assert.equal(current.closes(), 1, "nothing moved, so the head is the head");
});

test("A11-248: a member with a file of its own is not closed, and is not read again at the same head", () => {
  const { host, pool, next, reads, closes, restacked } = world();
  restacked();
  pool.retargetStacked();
  pool.retargetStacked();
  assert.equal(reads(), 1, "read once at its head");
  assert.equal(closes(), 0);
  assert.equal(next().retargets![NEXT], RESTACKED);
  host.pullAt(NEXT)!.head = "e".repeat(40);
  pool.retargetStacked();
  assert.equal(reads(), 2, "and again once the head moved");
});

test("A11-248: a member whose list of files was cut short is not closed", () => {
  const { host, pool, next, closes, restacked, emptied } = world();
  restacked();
  emptied();
  host.pullAt(NEXT)!.feedback = { filesComplete: false };
  pool.retargetStacked();
  assert.equal(closes(), 0);
  assert.equal(next().retargets![NEXT], RESTACKED);
});

test("A11-248: a refused close keeps GitHub's reason on the card and is tried again on the next sweep", () => {
  const { host, pool, next, closes, restacked, emptied } = world();
  restacked();
  emptied();
  host.closes.refusals.set(NEXT, "Resource not accessible by integration");
  pool.retargetStacked();
  assert.equal(next().retargets![NEXT], "#2 has no changes of its own after #1 merged, and closing it failed: Resource not accessible by integration; agent-org tries again");
  assert.equal(host.readPullState(NEXT), "OPEN");
  host.closes.refusals.clear();
  pool.retargetStacked();
  assert.equal(closes(), 2, "tried again");
  assert.equal(next().retargets![NEXT], CLOSED);
});

test("A11-248: a code host without closePull gets the note that says to close the member, and no call", () => {
  const { host, pool, next, closes, restacked, emptied } = world({ codeHost: (fake) => ({ ...fake, closePull: undefined }) });
  restacked();
  emptied();
  pool.retargetStacked();
  assert.equal(next().retargets![NEXT], "#2 has no changes of its own after #1 merged: close it, because this code host cannot");
  assert.equal(closes(), 0);
  assert.deepEqual(host.closes.closed, []);
  host.pullAt(NEXT)!.files = ["src/the-next-member.ts"];
  pool.retargetStacked();
  assert.equal(next().retargets![NEXT], RESTACKED, "a member that gained a file of its own is not to be closed any more");
});

test("A11-248: an empty member is not closed by a board that restarted after it was restacked, once its note says it was", () => {
  const { host, pool, next, closes, restacked, emptied, fixture } = world();
  restacked();
  emptied();
  const restarted = fixture.restart({ codeHost: host });
  restarted.retargetStacked();
  assert.equal(closes(), 1, "the note stands in for the memory the restart lost");
  assert.equal(next().retargets![NEXT], CLOSED);
  pool.retargetStacked();
  assert.equal(closes(), 1);
});

test("A11-248: a member whose restack conflicted is never closed, whatever its files", () => {
  const { host, pool, next, closes, emptied } = world({ next: { rounds: 3 } });
  host.branchUpdates.answers.set(NEXT, { kind: "conflict" });
  pool.retargetStacked();
  assert.match(next().retargets![NEXT], /^#2 conflicts with main after #1 merged/);
  host.pullAt(NEXT)!.head = MERGED_IN_HEAD;
  emptied();
  pool.retargetStacked();
  pool.retargetStacked();
  assert.equal(closes(), 0);
});

test("A11-248: a member whose restack was refused is never closed, whatever its files", () => {
  const { host, pool, next, closes, emptied } = world();
  host.branchUpdates.answers.set(NEXT, { kind: "refused", reason: "expected head sha didn't match" });
  emptied();
  pool.retargetStacked();
  pool.retargetStacked();
  assert.match(next().retargets![NEXT], /could not be restacked/);
  assert.equal(closes(), 0, "it is restacked again, not closed");
});

test("A11-248: a closed member starts nothing: the watch and a refresh of the tracker leave the run finished, with no round queued", async () => {
  const { pool, next, restacked, emptied, host } = world();
  restacked();
  emptied();
  pool.retargetStacked();
  host.pullAt(NEXT)!.feedback = { conflicting: true };
  host.pullAt(NEXT)!.merge = { armed: false, mergeable: false };
  pool.watchFeedback();
  await pool.refreshTracker();
  pool.watchFeedback();
  assert.equal(next().phase, "finished");
  assert.equal(next().rounds ?? 0, 0, "no round");
  assert.equal(next().feedback, undefined);
});
