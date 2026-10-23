// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 6): THE FAKE CODE HOST'S OPERATIONS FOR THE WORK GATE. Core's tests of the gate's readers seed `FakeRowsWorld.gate` and call the reader with no `run`; these cases hold what they rely on: a row's label
 * history, who wrote a comment, the pull requests and checks the gate reads, the writes it makes, a refused read, and the executor's process, which a fake has none of.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};

function seeded() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.rows.set(7, fakeRow(world, 7, { labels: ["needs:chairman"], comments: [{ id: 1, body: "first", createdAt: "2026-10-04T10:00:00Z", author: "the-chairman" }, { id: 2, body: "second", createdAt: "2026-10-04T11:00:00Z" }] }));
  world.gate.events.set(7, [
    { event: "labeled", label: "needs:chairman", actor: "ceo", at: "2026-10-03T09:00:00Z" },
    { event: "unlabeled", label: "needs:chairman", actor: "ceo", at: "2026-10-03T10:00:00Z" },
    { event: "labeled", label: "needs:chairman", actor: null, at: "2026-10-03T11:00:00Z" },
  ]);
  return { world, rows: host.rows! };
}

test("a row's history: the labels applied and taken off, who applied the newest, and the comments with their authors", () => {
  const { rows } = seeded();
  assert.deepEqual(rows.labeledEventTimesOf({ number: 7, label: "needs:chairman", run: refused }), ["2026-10-03T09:00:00Z", "2026-10-03T11:00:00Z"]);
  assert.deepEqual(rows.unlabeledEventsOf({ repo: "x/y", number: 7, run: refused }), [{ name: "needs:chairman", at: "2026-10-03T10:00:00Z" }]);
  assert.equal(rows.newestLabellerOf({ number: 7, label: "needs:chairman", run: refused }), null, "the newest labeller is unknown when its actor is gone, never an older one's");
  assert.deepEqual(rows.commentActivityOf({ number: 7, run: refused }), [{ author: "the-chairman", at: "2026-10-04T10:00:00Z", body: "first" }, { author: "", at: "2026-10-04T11:00:00Z", body: "second" }]);
  assert.deepEqual(rows.rowTimelineOf({ repo: "x/y", number: 7, run: refused }).map((e) => e.event), ["labeled", "unlabeled", "labeled", "commented", "commented"]);
  assert.deepEqual(rows.rowStateAndNewestComment({ repo: "x/y", number: 7, run: refused }), { state: "open", lastComment: { body: "second", createdAt: "2026-10-04T11:00:00Z" } });
  assert.equal(rows.rowStateAndNewestComment({ repo: "x/y", number: 99, run: refused }), null, "a row the fake holds none of is one that cannot be read whole");
});

test("a refused read of one row's history is that row's alone: its events throw, another row's are read", () => {
  const { world, rows } = seeded();
  world.rows.set(8, fakeRow(world, 8));
  world.gate.events.set(8, new Error("HTTP 403"));
  world.gate.commentsRefused.add(8);
  assert.throws(() => rows.labeledEventTimesOf({ number: 8, label: "x", run: refused }), /HTTP 403/);
  assert.throws(() => rows.commentActivityOf({ number: 8, run: refused }), /refuses the comments of #8/);
  assert.equal(rows.labeledEventTimesOf({ number: 7, label: "needs:chairman", run: refused }).length, 2);
});

test("the gate's writes land on the world: a comment, a label, a body, a row filed, a card with its Status, a pull request readied", () => {
  const { world, rows } = seeded();
  rows.commentOnRow({ number: 7, body: "brief", run: refused });
  rows.addLabelToRow({ number: 7, label: "answer:ceo", run: refused });
  rows.removeLabelFromRow({ number: 7, label: "needs:chairman", run: refused });
  rows.setRowBody({ number: 7, body: "new body", run: refused });
  const filed = rows.fileLabelledRow({ title: "t", label: "incident", body: "b", run: refused });
  assert.match(filed, /\/issues\/\d+\n$/);
  const row = world.rows.get(7)!;
  assert.deepEqual([row.comments.at(-1)?.body, row.labels, row.body], ["brief", ["answer:ceo"], "new body"]);
  assert.ok([...world.rows.values()].some((candidate) => candidate.title === "t" && candidate.labels.join() === "incident"));
  assert.throws(() => rows.setProjectStatus({ owner: "o", projectNumber: 1, url: "https://github.com/x/y/issues/7", status: "Ready", run: refused }), /not an item of the project/, "a Status for a row that is not on the board is refused, as GitHub refuses it");
  rows.addRowToProject({ owner: "o", projectNumber: 1, url: "https://github.com/x/y/issues/7", run: refused });
  rows.setProjectStatus({ owner: "o", projectNumber: 1, url: "https://github.com/x/y/issues/7", status: "Ready", run: refused });
  assert.deepEqual([row.onBoard, row.boardStatus], [true, "Ready"]);
  world.pulls.set(3, { number: 3, body: "", headRefName: "b", labels: [], isDraft: true, armed: false, merged: false, mergedAt: null, createdAt: "t", comments: [] });
  rows.markPullReady({ number: 3, run: refused });
  assert.equal(world.pulls.get(3)!.isDraft, false);
});

test("the pull requests, commits, checks and runs the gate reads are the world's, and an absent diff or job is refused as GitHub refuses it", () => {
  const { world, rows } = seeded();
  world.pulls.set(3, { number: 3, body: "", headRefName: "a11-3-x", labels: ["x"], isDraft: false, armed: false, merged: true, mergedAt: "2026-10-05T00:00:00Z", createdAt: "t", comments: [], files: ["a.ts"], commits: ["c1", "c2"], title: "T" });
  assert.deepEqual(rows.pullsOfBranch({ branch: "a11-3-x", limit: 10, run: refused }), [{ number: 3, state: "MERGED" }]);
  assert.deepEqual(rows.newestMergedPulls({ run: refused })?.map(({ number, title }) => [number, title]), [[3, "T"]]);
  assert.deepEqual([rows.pullFileNamesOf({ number: 3, run: refused }), rows.commitShasOf({ repo: "x/y", number: 3, run: refused })], [["a.ts"], ["c1", "c2"]]);
  assert.throws(() => rows.compareDiffOf({ repo: "x/y", base: "main", head: "abc", run: refused }), /holds no diff main\.\.\.abc/);
  world.gate.diffs.set("main...abc", "diff");
  assert.equal(rows.compareDiffOf({ repo: "x/y", base: "main", head: "abc", run: refused }), "diff");
  world.gate.mergeGroupRuns = [{ id: 9, head_branch: "b", conclusion: "failure", created_at: "t" }];
  assert.deepEqual(rows.mergeGroupRunsOf({ repo: "x/y", withConclusion: false, run: refused }), [{ id: 9, head_branch: "b", created_at: "t" }]);
  assert.equal(rows.mergeGroupRunsOf({ repo: "x/y", withConclusion: true, run: refused })[0].conclusion, "failure");
  assert.throws(() => rows.jobsOfMergeGroupRun({ repo: "x/y", runId: 9, run: refused }), /holds no jobs of run 9/);
  assert.equal(rows.readRequiredContexts({ run: refused }).contexts, null, "the checks that no source lists are null with the report, never nothing blocks");
  world.gate.requiredChecks = ["gate"];
  assert.deepEqual(rows.readRequiredContexts({ run: refused }), { contexts: ["gate"] });
});

test("the executor's process: a fake has no gh to start, and says so by name", () => {
  const { rows } = seeded();
  assert.throws(() => rows.gateRun({ timeoutMs: 1, capture: false }), /no gh to start for the gate's executor/);
  assert.throws(() => rows.runTogether({ calls: [], env: {}, callMs: 1, graceMs: 1, maxBuffer: 1 }), /no gh to start for a batch of calls/);
});

test("a test can count what the gate read: the reads of history, diffs, checks and jobs, and the pull requests readied, are lines in the world's calls", () => {
  const { world, rows } = seeded();
  world.pulls.set(3, { number: 3, body: "", headRefName: "b", labels: [], isDraft: true, armed: false, merged: false, mergedAt: null, createdAt: "t", comments: [] });
  world.gate.diffs.set("main...abc", "d");
  world.gate.actionsJobs.set("77", { conclusion: "success", runner_name: "r", steps: 2 });
  rows.labeledEventTimesOf({ number: 7, label: "needs:chairman", run: refused });
  rows.compareDiffOf({ repo: "x/y", base: "main", head: "abc", run: refused });
  rows.failingCheckNamesAt({ repo: "x/y", commit: "abc", run: refused });
  rows.actionsJobOf({ repo: "x/y", jobId: "77", run: refused });
  rows.waitRefOf({ repo: world.repo, number: 7, run: refused });
  rows.markPullReady({ number: 3, run: refused });
  rows.markPullReady({ number: 3, repo: "o/r", run: refused });
  assert.deepEqual(world.calls, ["labeledEventTimesOf #7", "compareDiffOf main...abc", "failingCheckNamesAt abc", "actionsJobOf 77", "waitRefOf fake/tracker#7", "markPullReady #3", "markPullReady o/r#3"]);
});

test("a history is seeded one login a line, `null` for an actor that is gone, or as a history that cannot be read", async () => {
  const { seedLabelHistory } = await import("./code-host-gate.ts");
  const { world, rows } = seeded();
  world.rows.set(9, fakeRow(world, 9));
  seedLabelHistory(world, { number: 9, label: "priority:chairman", actors: "ceo\nthe-chairman\nnull\n", endingAt: Date.parse("2026-10-05T00:00:00Z") });
  assert.deepEqual(rows.labeledEventTimesOf({ number: 9, label: "priority:chairman", run: refused }), ["2026-10-04T23:57:00.000Z", "2026-10-04T23:58:00.000Z", "2026-10-04T23:59:00.000Z"]);
  assert.equal(rows.newestLabellerOf({ number: 9, label: "priority:chairman", run: refused }), null, "the newest labeller's actor is gone: unknown, never the one before");
  seedLabelHistory(world, { number: 9, label: "priority:chairman", actors: new Error("HTTP 403") });
  assert.throws(() => rows.labeledEventTimesOf({ number: 9, label: "priority:chairman", run: refused }), /HTTP 403/);
});

test("the knobs for a read that came back wrong: an answer-label list that is not a list, closed rows that are not whole or not filtered, a refused kind, the recently-closed nodes as the test wants them, a repository's own closed pull requests", () => {
  const { world, rows } = seeded();
  world.rows.set(10, fakeRow(world, 10, { state: "CLOSED", closedAt: "2026-10-02T00:00:00Z", labels: ["answer:ceo"] }));
  world.rows.set(11, fakeRow(world, 11, { state: "CLOSED", closedAt: "2026-10-02T00:00:00Z", labels: ["other"] }));
  assert.deepEqual(rows.labelNamesWithPrefix({ prefix: "answer:", run: refused }), ["answer:ceo"]);
  world.gate.labelListNotAList = true;
  assert.equal(rows.labelNamesWithPrefix({ prefix: "answer:", run: refused }), null);
  assert.deepEqual(rows.closedRowsCarryingLabels({ names: ["answer:ceo"], kind: "issues", run: refused })?.map(({ number }) => number), [10]);
  world.gate.closedRowsUnfiltered = true;
  assert.deepEqual(rows.closedRowsCarryingLabels({ names: ["answer:ceo"], kind: "issues", run: refused })?.map(({ number }) => number), [10, 11], "the server's filter switched off, so a caller's own is tested apart");
  world.gate.closedRowsNotWhole.add("pullRequests");
  assert.equal(rows.closedRowsCarryingLabels({ names: ["answer:ceo"], kind: "pullRequests", run: refused }), null);
  world.failures.set("closedRowsCarryingLabels issues", new Error("HTTP 502"));
  assert.throws(() => rows.closedRowsCarryingLabels({ names: ["x"], kind: "issues", run: refused }), /HTTP 502/);
  assert.equal(rows.closedRowsCarryingLabels({ names: ["x"], kind: "pullRequests", run: refused }), null, "a refusal of one kind leaves the other kind's read alone");
  world.gate.recentlyClosed = [{ number: 1 }];
  assert.deepEqual(rows.recentlyClosedRowsOf({ limit: 5, run: refused }), [{ number: 1 }]);
  world.gate.recentlyClosed = new Error("HTTP 403");
  assert.throws(() => rows.recentlyClosedRowsOf({ limit: 5, run: refused }), /HTTP 403/);
  world.gate.closedPulls = [{ at: "a" }];
  world.gate.closedPullsByRepo = new Map([["o/r", [{ at: "b" }]]]);
  assert.deepEqual([rows.closedPullsPage({ repo: "o/r", page: 1, pageSize: 10, run: refused }), rows.closedPullsPage({ repo: "x/y", page: 1, pageSize: 10, run: refused })], [[{ at: "b" }], [{ at: "a" }]]);
});
