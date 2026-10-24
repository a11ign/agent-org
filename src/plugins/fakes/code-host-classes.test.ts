// no-token: none -- the in-memory code host holds a world and spawns nothing
/**
 * A11-160 (step 9): THE FAKE'S OPERATIONS FOR THE CLASSES SECTION. They act on the world a test seeds and ignore the `run` a caller hands them, in the contract's shapes. Each case below is a thing a core test of
 * `ci-failure-class.ts`, `class-repeat.ts`, `provider-low-confidence.ts`, `hand-fix-ledger.ts`, `decision-confidence-post.ts`, `tracker-comment.ts`, `fleet-gated-nightly.ts` or `host-kernel.ts` leans on, so a fake that
 * answered otherwise would make those tests pass or fail for the wrong reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";
import { fakePull } from "./code-host-pulls.ts";

const NO_RUN = (): string => { throw new Error("the fake runs nothing"); };
function world() {
  const host = createFakeCodeHost();
  return { rows: host.rows!, world: host.rowsWorld };
}
const closedAt = (day: number) => `2026-10-0${day}T12:00:00Z`;

test("a red check is read at the head it was seeded at: another head, or none red, is null, and a pull request never seeded is a refusal", () => {
  const { rows, world: w } = world();
  w.tail.classes.failingChecksOf.set("o/r#7", { headSha: "abcdef12".padEnd(40, "0"), read: { branch: "b", workflow: "CI", runAttempt: 1, log: "x" } });
  assert.equal(rows.redCheckOf({ repo: "o/r", number: 7, head8: "abcdef12", run: NO_RUN })?.workflow, "CI");
  assert.equal(rows.redCheckOf({ repo: "o/r", number: 7, head8: "12345678", run: NO_RUN }), null);
  assert.throws(() => rows.redCheckOf({ repo: "o/r", number: 8, head8: "abcdef12", run: NO_RUN }), /holds no pull request o\/r#8/);
  w.tail.classes.failingChecksOf.set("o/r#7", new Error("HTTP 502"));
  assert.throws(() => rows.redCheckOf({ repo: "o/r", number: 7, head8: "abcdef12", run: NO_RUN }), /HTTP 502/);
});

test("the jobs, their failed steps and logs, the files of a pull request and the runs are the ones seeded, cut at the page asked", () => {
  const { rows, world: w } = world();
  w.tail.classes.jobs.set("11", { failedStep: "Install", log: "boom" });
  assert.equal(rows.jobFailedStepOf({ repo: "o/r", jobId: 11, run: NO_RUN }), "Install");
  assert.equal(rows.jobLogTextOf({ repo: "o/r", jobId: "11", run: NO_RUN }), "boom");
  assert.throws(() => rows.jobLogTextOf({ repo: "o/r", jobId: 12, run: NO_RUN }), /holds no job 12/);
  assert.deepEqual(rows.jobOfCheckUrl("https://github.com/o/r/actions/runs/1/job/11"), { repo: "o/r", jobId: "11" });
  w.tail.classes.pullFiles.set("o/r#7", ["a", "b", "c"]);
  w.tail.classes.pullFiles.set("o/r#8", null);
  assert.deepEqual(rows.changedFilesPageOf({ repo: "o/r", number: 7, perPage: 2, run: NO_RUN }), ["a", "b"]);
  assert.equal(rows.changedFilesPageOf({ repo: "o/r", number: 8, perPage: 2, run: NO_RUN }), null);
  w.tail.classes.recentRuns.onMain = [{ name: "CI" }, { name: "CD" }];
  assert.deepEqual(rows.recentRunsOf({ repo: "o/r", kind: "on-main", limit: 1, run: NO_RUN }), [{ name: "CI" }]);
  assert.deepEqual(rows.recentRunsOf({ repo: "o/r", kind: "failing-for-pull-requests", limit: 5, run: NO_RUN }), []);
});

test("a branch update takes a pull request that is open and behind, refuses what it was seeded to refuse, and leaves the branch up to date", () => {
  const { rows, world: w } = world();
  w.tail.classes.refreshPulls.set("o/r#1", { open: true, mergedAt: null, behindBy: 3, updateRefusal: null });
  w.tail.classes.refreshPulls.set("o/r#2", { open: true, mergedAt: null, behindBy: 3, updateRefusal: "422 merge conflict" });
  w.tail.classes.refreshPulls.set("o/r#3", { open: false, mergedAt: "2026-10-01T00:00:00Z", behindBy: 0, updateRefusal: null });
  assert.equal(rows.openPullBehindBy({ repo: "o/r", number: 1, run: NO_RUN }), 3);
  assert.equal(rows.openPullBehindBy({ repo: "o/r", number: 3, run: NO_RUN }), null, "a pull request that is not open is not compared");
  assert.equal(rows.pullMergedAtOf({ repo: "o/r", number: 3, run: NO_RUN }), "2026-10-01T00:00:00Z");
  rows.updatePullBranch({ repo: "o/r", number: 1, run: NO_RUN });
  assert.throws(() => rows.updatePullBranch({ repo: "o/r", number: 2, run: NO_RUN }), /merge conflict/);
  assert.deepEqual(w.tail.classes.branchUpdates, ["o/r#1"]);
  assert.equal(rows.openPullBehindBy({ repo: "o/r", number: 1, run: NO_RUN }), 0);
});

test("an incident row is filed as an open row of the world carrying the label, whose label was made first; the rows read back are the world's, newest first, with their closing pull requests", () => {
  const { rows, world: w } = world();
  w.nextNumber = 40;
  assert.equal(rows.fileSharedFailureRow({ label: "ci-shared-failure", description: "d", title: "t", body: "b", run: NO_RUN }), 40);
  assert.equal(rows.fileSharedFailureRow({ label: "ci-shared-failure", description: "d", title: "t2", body: "b2", run: NO_RUN }), 41);
  assert.deepEqual(w.labelsCreated, ["ci-shared-failure"]);
  w.rows.set(7, fakeRow(w, 7, { state: "CLOSED", labels: ["ci-shared-failure"], closedAt: closedAt(2), body: "old" }));
  w.tail.classes.closedBy.set(7, [{ number: 5004, repo: "a/b" }]);
  assert.deepEqual(rows.sharedFailureRowsOf({ label: "ci-shared-failure", state: "open", newest: 1, run: NO_RUN }).map((row) => row.number), [41], "newest first, at most `newest`");
  const [closed] = rows.sharedFailureRowsOf({ label: "ci-shared-failure", state: "closed", newest: 20, run: NO_RUN });
  assert.deepEqual([closed.number, closed.body, closed.closedAt, closed.closedBy], [7, "old", closedAt(2), [{ number: 5004, repo: "a/b" }]]);
});

test("the closed rows are newest-updated first and cut at the page AFTER the label narrows them; none is a pull request, and a listing can be made to answer null, refuse, or be watched", () => {
  const { rows, world: w } = world();
  w.rows.set(1, fakeRow(w, 1, { state: "CLOSED", labels: ["class:x"], closedAt: closedAt(1), title: "one" }));
  w.rows.set(2, fakeRow(w, 2, { state: "CLOSED", labels: ["bug"], closedAt: closedAt(3), title: "two" }));
  w.rows.set(3, fakeRow(w, 3, { state: "CLOSED", labels: ["class:x"], closedAt: closedAt(2), title: "three" }));
  w.rows.set(4, fakeRow(w, 4, { state: "OPEN", labels: ["class:x"] }));
  fakePull(w, 5, { labels: ["class:x"] });
  assert.deepEqual(rows.closedClassRowsOf({ repo: "o/r", classLabel: null, perPage: 2, run: NO_RUN })?.map((row) => row.number), [2, 3]);
  assert.deepEqual(rows.closedClassRowsOf({ repo: "o/r", classLabel: "class:x", perPage: 2, run: NO_RUN })?.map((row) => [row.number, row.closedAt]), [[3, Date.parse(closedAt(2))], [1, Date.parse(closedAt(1))]]);
  assert.deepEqual(rows.closedRowsTitledOf({ repo: "o/r", perPage: 10, run: NO_RUN })?.map((row) => row.title), ["two", "three", "one"]);
  assert.deepEqual(w.calls, ["closedClassRowsOf -", "closedClassRowsOf class:x", "closedRowsTitledOf"]);
  w.tail.classes.notAListing = ["class-rows"];
  assert.equal(rows.closedClassRowsOf({ repo: "o/r", classLabel: null, perPage: 2, run: NO_RUN }), null);
  assert.ok(rows.closedRowsTitledOf({ repo: "o/r", perPage: 10, run: NO_RUN }) !== null, "only the listing named answers null");
  w.tail.classes.onClosedRowsRead = (_listing, label) => { if (label === "class:x") throw new Error("HTTP 502"); };
  assert.throws(() => rows.closedClassRowsOf({ repo: "o/r", classLabel: "class:x", perPage: 2, run: NO_RUN }), /HTTP 502/);
});

test("the rows of a label come open first, then closed; the open rows of a label carry their comments and are cut at the limit, newest first", () => {
  const { rows, world: w } = world();
  w.rows.set(1, fakeRow(w, 1, { state: "CLOSED", labels: ["l"], closedAt: closedAt(1) }));
  w.rows.set(2, fakeRow(w, 2, { labels: ["l"], comments: [{ id: 1, body: "hi", createdAt: closedAt(1) }] }));
  w.rows.set(3, fakeRow(w, 3, { labels: ["l"] }));
  w.rows.set(4, fakeRow(w, 4, { labels: ["other"] }));
  assert.deepEqual(rows.labelledRowsOf({ repo: "o/r", label: "l", run: NO_RUN }).map((row) => [row.number, row.state]), [[3, "OPEN"], [2, "OPEN"], [1, "CLOSED"]]);
  assert.deepEqual(rows.openRowsCarryingLabel({ repo: "o/r", label: "l", limit: 1, run: NO_RUN }), [{ number: 3, comments: [] }]);
  assert.deepEqual(rows.openRowsCarryingLabel({ repo: "o/r", label: "l", limit: 5, run: NO_RUN })[1], { number: 2, comments: [{ body: "hi" }] });
  assert.deepEqual(w.calls, ["labelledRowsOf l", "openRowsCarryingLabel l limit=1", "openRowsCarryingLabel l limit=5"], "the bound a caller asked for is in the calls");
});

test("the logins of main's commits and the merged pull requests since a day are what the world holds; a seeded error is a refusal", () => {
  const { rows, world: w } = world();
  w.tail.classes.commitLogins = [{ sha: "s1", login: "DanBeckDev" }, { sha: "s2", login: null }];
  assert.deepEqual(rows.mainCommitLoginsSince({ repo: "o/r", since: new Date(0), run: NO_RUN }), w.tail.classes.commitLogins);
  fakePull(w, 77, { merged: true, mergedAt: "2026-09-30T10:00:00Z", author: null, title: "x", body: "the body" });
  fakePull(w, 78, { merged: true, mergedAt: "2026-08-30T10:00:00Z", author: "a", title: "old", body: "" });
  fakePull(w, 79, { title: "open one" });
  assert.deepEqual(rows.mergedPullsSince({ repo: "o/r", since: new Date("2026-09-03T12:00:00Z"), maxPages: 50, run: NO_RUN }), [{ number: 77, author: null, title: "x", body: "the body" }]);
  w.tail.classes.commitLogins = new Error("HTTP 401");
  assert.throws(() => rows.mainCommitLoginsSince({ repo: "o/r", since: new Date(0), run: NO_RUN }), /HTTP 401/);
});

test("the epic's daily comment: posted once under its marker for a day, found again the same day, posted again the next", () => {
  const { rows, world: w } = world();
  const epic = fakeRow(w, 4627);
  w.rows.set(4627, epic);
  const post = (day: string) => rows.postMarkedIssueComment({ repo: w.repo, issue: 4627, marker: `<!-- m: ${day} -->`, day, text: "reading", run: NO_RUN });
  const first = post("2026-10-10");
  assert.equal(first.posted && first.ref, String(epic.comments[0].id));
  assert.equal(epic.comments[0].body, "<!-- m: 2026-10-10 -->\nreading");
  assert.deepEqual(post("2026-10-10"), { posted: false });
  assert.equal(epic.comments.length, 1);
  assert.equal(post("2026-10-11").posted, true, "a comment of yesterday's marker is not today's");
  assert.throws(() => rows.postMarkedIssueComment({ repo: w.repo, issue: 99, marker: "m", day: "2026-10-10", text: "t", run: NO_RUN }), /no row/);
});

test("a comment read is a body unless the world was seeded with something else", () => {
  const { rows, world: w } = world();
  const epic = fakeRow(w, 4627);
  epic.comments.push({ id: 5, body: "<!-- m -->\nfirst", createdAt: "2026-10-10T08:00:00Z" }, { id: 6, body: "<!-- m -->\nyesterday", createdAt: "2026-10-09T08:00:00Z" }, { id: 7, body: "other", createdAt: "2026-10-10T09:00:00Z" });
  w.rows.set(4627, epic);
  assert.deepEqual(rows.commentBodyOf({ repo: w.repo, id: 5, run: NO_RUN }), { kind: "body", body: "<!-- m -->\nfirst" });
  w.tail.classes.commentReads.set(5, { kind: "not-json", head: "<html>" });
  assert.equal(rows.commentBodyOf({ repo: w.repo, id: 5, run: NO_RUN }).kind, "not-json");
  assert.throws(() => rows.commentBodyOf({ repo: w.repo, id: 99, run: NO_RUN }), /holds no comment 99/);
});

test("a comment on a row of the checkout's repository by input is the world's and recorded with where it ran; a row the world does not hold is a refusal", () => {
  const { rows, world: w } = world();
  const row = fakeRow(w, 4046);
  w.rows.set(4046, row);
  rows.commentOnCheckoutRowByInput({ number: 4046, body: "read back", cwd: "/project", timeoutMs: 60_000 });
  assert.deepEqual([row.comments.map((c) => c.body), w.tail.classes.checkoutComments], [["read back"], [{ number: "4046", body: "read back", cwd: "/project" }]]);
  assert.throws(() => rows.commentOnCheckoutRowByInput({ number: 1, body: "b", cwd: "/p", timeoutMs: 1 }), /holds no row/);
});
