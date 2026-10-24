// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 9): THE FAKE CODE HOST'S OPERATIONS FOR THE CLOSING SECTION. Core's tests of the close paths, the settle pass, the closes check, the sweep freeze, the worktree removers and `worker:state` seed the world and
 * call their callers with no `run`; these cases hold what they rely on: a close writes the row, a declared row is read with its reopening and its build fields, a merged pull request's closing references are the rows its
 * `closes` names, the closed-row pages are the seeded ones in order, and a read the world does not hold is a refused read (or `null` where GitHub says there is no such issue).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow, type FakeRowPull } from "./code-host-rows.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};

const pull = (number: number, over: Partial<FakeRowPull> = {}): FakeRowPull =>
  ({ number, body: "Closes #1", headRefName: `agent/x-${number}`, labels: [], isDraft: false, armed: false, merged: true, mergedAt: "2026-10-01T10:00:00Z", createdAt: "2026-10-01T09:00:00Z", comments: [], ...over });

function seeded() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = "a11ign/a11ign";
  world.rows.set(1, fakeRow(world, 1, { title: "build", body: "Done-when: x", labels: ["in-progress", "session:a"], milestone: { number: 3, title: "v2", description: null, dueOn: null } }));
  world.rows.set(2, fakeRow(world, 2, { title: "closed", state: "CLOSED", closedAt: "2026-09-09T10:00:00Z", onBoard: true }));
  world.pulls.set(10, pull(10, { closes: [{ number: 1, labels: ["in-progress"] }, { number: 2, labels: [] }] }));
  world.tail.closing.reopenedAt.set(1, "2026-10-02T00:00:00Z");
  world.tail.closing.parents.set(1, 99);
  world.tail.closing.mergeShas.set(10, "abc123");
  return { world, rows: host.rows! };
}

test("a close writes the row: its comment, its state and its time; a row the world does not hold is a refused read, and a close refused for a row throws its error", () => {
  const { world, rows } = seeded();
  rows.closeCompletedRow({ repo: "a11ign/a11ign", row: 1, comment: "Closed by the pipeline.", run: refused });
  assert.equal(world.rows.get(1)?.state, "CLOSED");
  assert.equal(world.rows.get(1)?.comments.at(-1)?.body, "Closed by the pipeline.");
  assert.notEqual(world.rows.get(1)?.closedAt, null);
  assert.throws(() => rows.closeCompletedRow({ repo: "a11ign/a11ign", row: 404, comment: "c", run: refused }), /holds no row/);
  world.tail.closing.closeRefusals.set(2, new Error("HTTP 403"));
  assert.throws(() => rows.closeCompletedRow({ repo: "a11ign/a11ign", row: 2, comment: "c", run: refused }), /HTTP 403/);
});

test("a declared row carries its state, its labels and its last reopening; with its build fields it also carries title, body, milestone and parent; a number that is no issue is null", () => {
  const { rows } = seeded();
  assert.deepEqual(rows.declaredRowOf({ repo: "a11ign/a11ign", number: 1, run: refused }), { number: 1, state: "OPEN", labels: ["in-progress", "session:a"], reopenedAt: "2026-10-02T00:00:00Z" });
  assert.equal(rows.declaredRowOf({ repo: "a11ign/a11ign", number: 2, run: refused })?.reopenedAt, null, "a row never reopened");
  const both = rows.declaredBuildRowOf({ repo: "a11ign/a11ign", number: 1, run: refused });
  assert.deepEqual(both?.build, { number: 1, title: "build", body: "Done-when: x", labels: ["in-progress", "session:a"], milestone: "v2", parent: 99 });
  assert.deepEqual(rows.buildRowOf({ repo: "a11ign/a11ign", number: 2, run: refused })?.parent, null);
  for (const read of [rows.declaredRowOf, rows.declaredBuildRowOf, rows.buildRowOf]) assert.equal(read({ repo: "a11ign/a11ign", number: 777, run: refused }), null);
});

test("a merged pull request's closing references are the rows its `closes` names, as the world holds them; an unmerged one has none; its merge commit and base are the seeded ones", () => {
  const { world, rows } = seeded();
  const read = rows.mergedPullClosingOf({ repo: "a11ign/a11ign", number: "10", run: refused });
  assert.deepEqual([read.merged, read.baseRefName, read.mergeSha, read.mergedAt, read.headRefName, read.body], [true, "main", "abc123", "2026-10-01T10:00:00Z", "agent/x-10", "Closes #1"]);
  assert.deepEqual(read.closing.map(({ number, state, repo, reopenedAt }) => [number, state, repo, reopenedAt]), [[1, "OPEN", null, "2026-10-02T00:00:00Z"], [2, "CLOSED", null, null]]);
  const sweep = rows.closingRowsOfMergedPull({ repo: "a11ign/a11ign", number: 10, run: refused });
  assert.deepEqual(sweep.rows.map((row) => [row.number, row.build?.title]), [[1, "build"], [2, "closed"]]);
  world.tail.closing.baseRefNames.set(10, "release");
  assert.equal(rows.mergedPullClosingOf({ repo: "a11ign/a11ign", number: "10", run: refused }).baseRefName, "release");
  world.pulls.set(11, pull(11, { merged: false, mergedAt: null, closes: [{ number: 1, labels: [] }] }));
  assert.deepEqual(rows.mergedPullClosingOf({ repo: "a11ign/a11ign", number: "11", run: refused }).closing, [], "a pull request that has not merged closes nothing");
  assert.throws(() => rows.mergedPullClosingOf({ repo: "a11ign/a11ign", number: "12", run: refused }), /holds no pull request #12/);
});

test("a row filed in a milestone is the world's next row, carrying its labels and milestone; an edge and a sub-issue are recorded against rows the world holds", () => {
  const { world, rows } = seeded();
  const number = rows.fileRowInMilestone({ repo: "a11ign/a11ign", title: "Verify build", body: "<!-- verify-row: build #1 -->", labels: ["ready"], milestone: "v2", run: refused });
  assert.deepEqual([world.rows.get(number)?.title, world.rows.get(number)?.labels, world.rows.get(number)?.milestone?.title, world.rows.get(number)?.state], ["Verify build", ["ready"], "v2", "OPEN"]);
  rows.addBlockedByEdge({ repo: "a11ign/a11ign", row: number, blocker: 1, run: refused });
  assert.deepEqual(world.rows.get(number)?.blockedBy, [1]);
  rows.addSubIssueTo({ repo: "a11ign/a11ign", parent: 99, child: number, run: refused });
  assert.deepEqual(world.tail.closing.subIssues, [[99, number]]);
  assert.throws(() => rows.addSubIssueTo({ repo: "a11ign/a11ign", parent: 99, child: 5000, run: refused }), /holds no row/);
});

test("the closed rows on the board are one page derived from the world, or the seeded pages in the order they are read (an error among them is the read that throws)", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.closedRowPageOf({ owner: "a11ign", name: "a11ign", after: null, projectNumber: 1, run: refused }), { numbers: [2], hasNextPage: false, endCursor: null });
  world.tail.closing.pagesRead.length = 0;
  world.tail.closing.closedRowPages = [{ numbers: [1], hasNextPage: true, endCursor: "c1" }, new Error("HTTP 502"), { numbers: [3], hasNextPage: false, endCursor: null }];
  assert.deepEqual(rows.closedRowPageOf({ owner: "a11ign", name: "a11ign", after: null, projectNumber: 1, run: refused }).endCursor, "c1");
  assert.throws(() => rows.closedRowPageOf({ owner: "a11ign", name: "a11ign", after: "c1", projectNumber: 1, run: refused }), /HTTP 502/);
  assert.deepEqual(rows.closedRowPageOf({ owner: "a11ign", name: "a11ign", after: "c1", projectNumber: 1, run: refused }).numbers, [3]);
  assert.throws(() => rows.closedRowPageOf({ owner: "a11ign", name: "a11ign", after: "c3", projectNumber: 1, run: refused }), /no further page/);
  assert.deepEqual(world.tail.closing.pagesRead, [null, "c1", "c1", "c3"], "the cursors asked from are kept for a test to read");
});

test("the claimed rows are the open ones carrying the label with the newest comments of the window, and the total they would make; the head of a pull request and a consumer's file", () => {
  const { world, rows } = seeded();
  for (const body of ["a", "b", "c"]) world.rows.get(1)!.comments.push({ id: world.nextCommentId++, body, createdAt: "2026-10-01T00:00:00Z", author: "x" });
  const page = rows.claimedRowsWithComments({ repo: "a11ign/a11ign", label: "in-progress", count: 10, window: 2, run: refused });
  assert.deepEqual([page.total, page.rows.map((row) => [row.number, row.commentsTotal, row.comments.map((c) => c.body)])], [1, [[1, 3, ["b", "c"]]]]);
  assert.deepEqual(rows.headBranchAndForkOf({ repo: "a11ign/a11ign", number: 10, run: refused }), { branch: "agent/x-10", fork: false });
  world.pulls.get(10)!.isCrossRepository = true;
  assert.equal(rows.headBranchAndForkOf({ repo: "a11ign/a11ign", number: 10, run: refused }).fork, true);
  world.tail.closing.consumerFiles.set("a11ign/other:a.json", "{}");
  world.tail.closing.consumerFiles.set("a11ign/other:a.json@abc", "{\"v\":1}");
  assert.equal(rows.consumerFileTextOf({ repo: "a11ign/other", path: "a.json", run: refused }), "{}");
  assert.equal(rows.consumerFileTextOf({ repo: "a11ign/other", path: "a.json", ref: "abc", run: refused }), "{\"v\":1}");
  assert.throws(() => rows.consumerFileTextOf({ repo: "a11ign/other", path: "b.json", run: refused }), /holds no file/);
});

test("a row as `worker:state` reads it carries its comments with an id and an address; no such issue is null; the comments and the state of a row as the sweep freeze reads them", () => {
  const { world, rows } = seeded();
  world.rows.get(1)!.comments.push({ id: 41, body: "BLOCKED", createdAt: "2026-10-01T00:00:00Z", author: "chairman" });
  const row = rows.rowWithCommentsOf({ repo: "a11ign/a11ign", number: 1, run: refused });
  assert.deepEqual([row?.state, row?.labels, row?.body, row?.comments], ["OPEN", ["in-progress", "session:a"], "Done-when: x", [{ id: "41", url: "https://github.com/a11ign/a11ign/issues/1#issuecomment-41", body: "BLOCKED", createdAt: "2026-10-01T00:00:00Z" }]]);
  assert.equal(rows.rowWithCommentsOf({ repo: "a11ign/a11ign", number: 404, run: refused }), null);
  assert.deepEqual(rows.commentsOfRowIn({ repo: "a11ign/a11ign", number: 1, run: refused }), [{ id: "41", body: "BLOCKED", createdAt: "2026-10-01T00:00:00Z", author: { login: "chairman" } }]);
  assert.deepEqual(rows.rowStateAndLabelsOf({ repo: "a11ign/a11ign", number: 2, run: refused }), { state: "CLOSED", labels: [] });
  assert.deepEqual(rows.rowNumberStateAndLabelsOf({ repo: "a11ign/a11ign", number: 1, run: refused }), { number: 1, state: "OPEN", labels: ["in-progress", "session:a"] });
  assert.equal(rows.rateLimitDumpOf({ run: refused }).includes("X-Ratelimit-Used: 7"), true);
});
