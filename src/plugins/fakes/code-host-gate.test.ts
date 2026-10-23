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
