// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 9): THE FAKE CODE HOST'S OPERATIONS FOR THE READ-ONLY REPORTERS. Core's tests of those callers (the blast-radius gate, the CI-health liveness, release-behind-main, the review depth, the commit-liveness
 * watchdog, the lane authorship check, the branch inventory and the tick snapshot) seed the world and call them with no `run`; these cases hold what they rely on: a repository the world holds nothing of is a refused read
 * and never an empty one, the schedule runs and the report issue's comments are the ones a read would have returned, the commits of `main` are listed newest first by path, page and `since`, and a probe answers what was
 * seeded and records what it was asked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};
const REPO = "a11ign/agent-org";

function seeded() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.tail.readouts.trees.set(REPO, ["src/a.ts", "src/b.ts"]);
  world.tail.readouts.workflows.set(`${REPO}/ci-health.yml`, { path: ".github/workflows/ci-health.yml", state: "active", scheduledRuns: [{ id: 2, event: "schedule", created_at: "2026-10-05T07:00:00Z" }, { id: 1, event: "workflow_dispatch", created_at: "2026-10-03T12:00:00Z" }] });
  world.tail.readouts.files.set(`${REPO}:.github/workflows/ci-health.yml`, "cron: 43 6 * * 1");
  world.foreignRows.set(`${REPO}#928`, fakeRow(world, 928, { comments: [{ id: 1, body: "old", createdAt: "2026-09-28T07:00:00Z" }, { id: 2, body: "new", createdAt: "2026-10-05T07:30:00Z" }] }));
  world.tail.readouts.histories.set(REPO, {
    releases: [{ tag: "v2", publishedAt: "2026-10-07T00:00:00Z" }, { tag: "v2-draft", publishedAt: "2026-10-08T00:00:00Z", draft: true }, { tag: "v1", publishedAt: "2026-10-01T00:00:00Z" }],
    commits: [
      { sha: "c1", at: "2026-10-02T00:00:00Z", files: [{ filename: "src/a.ts" }], pulls: [{ number: 5, body: "x" }] },
      { sha: "c2", at: "2026-10-04T00:00:00Z", parents: 2, files: [{ filename: "docs/m.md", previous_filename: "src/m.ts" }], pulls: [] },
      { sha: "c3", at: "2026-10-06T00:00:00Z", files: [{ filename: "docs/only.md" }], pulls: [] },
    ],
  });
  return { world, rows: host.rows! };
}

test("a tree the world holds is listed, one it holds an error for throws it, and one it holds nothing of is a refused read", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.treeFilesOf({ repo: REPO, run: refused }), ["src/a.ts", "src/b.ts"]);
  world.tail.readouts.trees.set(REPO, new Error("tree truncated"));
  assert.throws(() => rows.treeFilesOf({ repo: REPO, run: refused }), /tree truncated/);
  assert.throws(() => rows.treeFilesOf({ repo: "a11ign/other", run: refused }), /the fake holds no tree of a11ign\/other/);
  world.failures.set(`treeFilesOf ${REPO}`, new Error("HTTP 502"));
  world.tail.readouts.trees.set(REPO, []);
  assert.throws(() => rows.treeFilesOf({ repo: REPO, run: refused }), /HTTP 502/, "a read refused for one repository");
});

test("the workflow, its file, its schedule runs and the report issue's comments since the slot are the world's; a workflow the world holds nothing of is HTTP 404", () => {
  const { world, rows } = seeded();
  assert.deepEqual(rows.workflowDefinitionOf({ repo: REPO, workflow: "ci-health.yml", run: refused }), { path: ".github/workflows/ci-health.yml", state: "active" });
  assert.equal(rows.rawFileTextOf({ repo: REPO, path: ".github/workflows/ci-health.yml", run: refused }), "cron: 43 6 * * 1");
  assert.deepEqual(rows.scheduledRunsOf({ repo: REPO, workflow: "ci-health.yml", perPage: 100, run: refused })?.map((run) => run.id), [2], "only the runs a schedule started");
  assert.deepEqual(rows.reportCommentBodiesOf({ repo: REPO, issue: 928, perPage: 100, since: null, run: refused }), ["old", "new"]);
  assert.deepEqual(rows.reportCommentBodiesOf({ repo: REPO, issue: 928, perPage: 100, since: "2026-10-05T06:43:00Z", run: refused }), ["new"], "since the slot: the comment before it is not returned");
  assert.throws(() => rows.workflowDefinitionOf({ repo: "a11ign/other", workflow: "ci-health.yml", run: refused }), /HTTP 404: Not Found/);
  assert.throws(() => rows.reportCommentBodiesOf({ repo: REPO, issue: 1, perPage: 100, since: null, run: refused }), /the fake holds no row/);
  world.failures.set(`workflowDefinitionOf ${REPO}`, new Error("HTTP 403: API rate limit exceeded"));
  assert.throws(() => rows.workflowDefinitionOf({ repo: REPO, workflow: "ci-health.yml", run: refused }), /rate limit exceeded/);
});

test("the releases are the newest that are not drafts, and the commits of main under a path are newest first, since a time, by page, a rename counting for both of its paths", () => {
  const { rows } = seeded();
  assert.deepEqual(rows.publishedReleasesOf({ repo: REPO, window: 10, run: refused }), [{ tag: "v2", at: "2026-10-07T00:00:00Z" }, { tag: "v1", at: "2026-10-01T00:00:00Z" }]);
  assert.deepEqual(rows.publishedReleasesOf({ repo: REPO, window: 1, run: refused }).map((release) => release.tag), ["v2"]);
  const under = (path: string, over: { page?: number; perPage?: number; since?: string | null } = {}) =>
    rows.pathCommitsPageOf({ repo: REPO, path, page: over.page ?? 1, perPage: over.perPage ?? 100, since: over.since ?? null, run: refused }).map((commit) => commit.sha);
  assert.deepEqual(under("src/"), ["c2", "c1"], "the rename out of src/ is listed under src/");
  assert.deepEqual(under("src/", { since: "2026-10-03T00:00:00Z" }), ["c2"]);
  assert.deepEqual(under("src/", { perPage: 1 }), ["c2"]);
  assert.deepEqual(under("src/", { perPage: 1, page: 2 }), ["c1"]);
  assert.deepEqual(rows.pathCommitsPageOf({ repo: REPO, path: "src/", page: 1, perPage: 100, since: null, run: refused })[0], { sha: "c2", at: "2026-10-04T00:00:00Z", parents: 2 });
  assert.deepEqual(rows.commitFilesOf({ repo: REPO, sha: "c2", run: refused }), [{ filename: "docs/m.md", previous_filename: "src/m.ts" }]);
  assert.deepEqual(rows.commitPullsOf({ repo: REPO, sha: "c1", run: refused }), [{ number: 5, body: "x" }]);
  assert.throws(() => rows.commitFilesOf({ repo: REPO, sha: "nope", run: refused }), /the fake holds no commit nope/);
  assert.throws(() => rows.publishedReleasesOf({ repo: "a11ign/other", window: 10, run: refused }), /the fake holds no history of a11ign\/other/);
});

test("a pull request's depth facts come from the detail a test seeded or the world's own pull request, its files are paged by the size asked, and the rows' bodies are the world's", () => {
  const { world, rows } = seeded();
  world.tail.readouts.pulls.set(`${REPO}#9`, { title: "t", body: "Closes #7", additions: 4, deletions: 1, files: ["a", "b", "c"] });
  assert.deepEqual(rows.pullDepthFactsOf({ repo: REPO, number: 9, run: refused }), { changedFiles: 3, additions: 4, deletions: 1, title: "t", body: "Closes #7" });
  assert.deepEqual(rows.pullFilenamesPageOf({ repo: REPO, number: 9, perPage: 2, run: refused }), ["a", "b"]);
  assert.deepEqual(rows.pullFilenamesOf({ repo: REPO, number: 9, run: refused }), ["a", "b", "c"]);
  world.pulls.set(3, { number: 3, body: "own", headRefName: "agent/x-3", labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-01T00:00:00Z", comments: [], title: "mine", files: ["z"] });
  assert.deepEqual(rows.pullDepthFactsOf({ repo: world.repo, number: 3, run: refused }), { changedFiles: 1, additions: 0, deletions: 0, title: "mine", body: "own" });
  world.rows.set(4, fakeRow(world, 4, { body: "## Region\n" }));
  assert.equal(rows.restRowBodyOf({ repo: world.repo, number: "4", run: refused }), "## Region\n");
  assert.throws(() => rows.pullDepthFactsOf({ repo: REPO, number: 99, run: refused }), /the fake holds no pull request/);
  assert.throws(() => rows.restRowBodyOf({ repo: REPO, number: 99, run: refused }), /the fake holds no row/);
});

test("the pull requests associated with a commit are the ones a test seeded for it, and a commit it seeded none for is a refused read", () => {
  const { world, rows } = seeded();
  world.tail.readouts.associated.set(`${REPO}@abc`, [{ number: 7, headRefOid: "h7" }]);
  assert.deepEqual(rows.commitAssociatedPullsOf({ repo: REPO, sha: "abc", run: refused }), [{ number: 7, headRefOid: "h7" }]);
  assert.throws(() => rows.commitAssociatedPullsOf({ repo: REPO, sha: "def", run: refused }), /the fake holds no pull requests associated with/);
});

test("the branch inventory's reads: the open pull requests' branches, the issues listing with pull requests carried, and a row's timeline from the gate's history", () => {
  const { world, rows } = seeded();
  world.rows.set(7, fakeRow(world, 7, { state: "CLOSED", labels: ["backlog"] }));
  world.pulls.set(20, { number: 20, body: "", headRefName: "agent/a-20", labels: ["ready"], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-01T00:00:00Z", comments: [] });
  world.pulls.set(21, { number: 21, body: "", headRefName: "agent/b-21", labels: [], isDraft: false, armed: false, merged: true, mergedAt: "2026-10-02T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", comments: [] });
  world.gate.events.set(7, [{ event: "labeled", label: "session:w", actor: null, at: "2026-10-01T00:00:00Z" }]);
  assert.deepEqual(rows.openPullHeadRefsOf({ repo: REPO, run: refused }), ["agent/a-20"]);
  assert.deepEqual(rows.issueProjectionOf({ repo: REPO, run: refused }), [
    { number: 7, state: "CLOSED", isPullRequest: false, labels: ["backlog"] },
    { number: 20, state: "OPEN", isPullRequest: true, labels: ["ready"] },
    { number: 21, state: "CLOSED", isPullRequest: true, labels: [] },
  ]);
  assert.deepEqual(rows.rowTimelineEventsOf({ repo: REPO, number: 7, run: refused }), [{ event: "labeled", label: { name: "session:w" } }]);
  assert.deepEqual(rows.rowTimelineEventsOf({ repo: REPO, number: 8, run: refused }), [], "a row with no history: the read worked");
  world.gate.events.set(8, new Error("HTTP 502"));
  assert.throws(() => rows.rowTimelineEventsOf({ repo: REPO, number: 8, run: refused }), /HTTP 502/);
});

test("a probe answers what a test seeded for its path and records the path and the held tag it was asked with; a path nothing was seeded for is refused", () => {
  const { world, rows } = seeded();
  world.tail.readouts.probes.set("p", { status: 304, etag: '"x"', facts: undefined });
  assert.deepEqual(rows.conditionalProbeOf({ path: "p", etag: '"t1"', timeoutMs: 1, maxBuffer: 1 }), { status: 304, etag: '"x"', facts: undefined });
  rows.conditionalProbeOf({ path: "p", etag: undefined, timeoutMs: 1, maxBuffer: 1 });
  assert.deepEqual(world.tail.readouts.probeAsks, [{ path: "p", etag: '"t1"' }, { path: "p", etag: undefined }]);
  assert.throws(() => rows.conditionalProbeOf({ path: "q", etag: undefined, timeoutMs: 1, maxBuffer: 1 }), /the fake holds no probe of q/);
});
