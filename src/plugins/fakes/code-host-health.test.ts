// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 8): THE FAKE CODE HOST'S OPERATIONS FOR THE ORG-HEALTH SWEEP, THE RELEASE ALARM AND THE RETRO. Core's tests of those callers run on this fake, so these cases hold what they rely on: a repository the world
 * holds nothing of is a refused read and not an empty one; a team's repositories render as the permission flags GitHub prints; the release runs, jobs and changesets answer as seeded; and `withRepositoryReads` answers the
 * retro's list reads of ANOTHER repository (rows with their comments, merged pull requests with their update time, files and merge commit), refusing per repository and cutting a window short as the pages would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowCutShort } from "../../ticket-port/window-cut-short.ts";
import { createFakeCodeHost } from "./code-host.ts";
import { holdRepository, withRepositoryReads, type FakeForeignPull } from "./code-host-health.ts";
import { fakeRow } from "./code-host-rows.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};

const pull = (number: number, over: Partial<FakeForeignPull> = {}): FakeForeignPull => ({ number, body: `body ${number}`, headRefName: `agent/p-${number}`, labels: [], isDraft: false, armed: false, merged: true, mergedAt: "2026-10-04T12:00:00Z",
  createdAt: "2026-10-04T11:00:00Z", comments: [], ...over });

test("a team's repositories render as the six permission flags GitHub prints, the highest level true and everything above it too, and a team the world holds nothing of is refused", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.reports.health.teamRepositories.set("a11ign/bots", [{ repo: "a/admin", level: "admin" }, { repo: "a/push", level: "push" }, { repo: "a/none", level: "none" }]);
  assert.equal(host.rows!.teamRepositoriesTextOf({ org: "a11ign", team: "bots", run: refused }), "a/admin\ttrue\ttrue\ttrue\ttrue\ttrue\na/push\tfalse\tfalse\ttrue\ttrue\ttrue\na/none\tfalse\tfalse\tfalse\tfalse\tfalse\n");
  assert.throws(() => host.rows!.teamRepositoriesTextOf({ org: "a11ign", team: "ci", run: refused }), /holds no team a11ign\/ci/);
});

test("the last merge is the latest merged_at among the repository's pull requests, `null` when none merged, and a repository the world holds nothing of is refused", () => {
  const host = createFakeCodeHost();
  holdRepository(host.rowsWorld, "o/code", { pulls: [pull(1, { mergedAt: "2026-10-01T07:25:01Z" }), pull(2, { mergedAt: "2026-10-01T09:00:00Z" }), pull(3, { merged: false, mergedAt: null, closedAt: "2026-10-01T10:00:00Z" })] });
  holdRepository(host.rowsWorld, "o/idle", { pulls: [pull(4, { merged: false, mergedAt: null })] });
  assert.equal(host.rows!.lastMergeTextOf({ repo: "o/code", window: 30, run: refused }), "2026-10-01T09:00:00Z\n");
  assert.equal(host.rows!.lastMergeTextOf({ repo: "o/idle", window: 30, run: refused }), "null\n");
  assert.throws(() => host.rows!.lastMergeTextOf({ repo: "o/unheld", window: 30, run: refused }), /holds no pull requests of o\/unheld/);
});

test("the release runs, a run's jobs and the changesets answer as seeded; the jobs are asked in the shape wanted, and what is not seeded is refused", () => {
  const host = createFakeCodeHost();
  const health = host.rowsWorld.reports.health;
  const runs = [{ id: 7, event: "push", status: "completed", conclusion: "failure", sha: "abc", createdAt: "t", updatedAt: "u", url: "x" }];
  health.releaseRuns.set("o/code", runs);
  health.releaseJobs.set("o/code#7", [{ id: 1, name: "guards", conclusion: "failure", failedSteps: ["Coverage"] }, { id: 2, name: "tag", conclusion: "skipped" }]);
  health.changesets.set("o/code", ["README.md", "a.md"]);
  assert.deepEqual(host.rows!.releaseRunsOf({ repo: "o/code", window: 30, run: refused }), runs);
  assert.deepEqual(host.rows!.releaseJobsOf({ repo: "o/code", runId: 7, window: 100, shape: "named", run: refused }), [{ name: "guards", conclusion: "failure" }, { name: "tag", conclusion: "skipped" }]);
  assert.deepEqual(host.rows!.releaseJobsOf({ repo: "o/code", runId: 7, window: 100, shape: "failed", run: refused }), [{ id: 1, name: "guards", steps: ["Coverage"] }]);
  assert.deepEqual(host.rows!.changesetNamesOf({ repo: "o/code", run: refused }), ["README.md", "a.md"]);
  assert.throws(() => host.rows!.releaseRunsOf({ repo: "o/other", window: 30, run: refused }), /holds no release runs/);
  assert.throws(() => host.rows!.releaseJobsOf({ repo: "o/code", runId: 8, window: 100, shape: "named", run: refused }), /holds no jobs of run o\/code#8/);
});

test("the open lists name the repository: its newest open rows and pull requests, and a repository held nothing of, or refused on its own, is a refused read", () => {
  const host = withRepositoryReads(createFakeCodeHost());
  const world = host.rowsWorld;
  holdRepository(world, "o/tracker", { rows: [fakeRow(world, 1, { labels: ["ready"] }), fakeRow(world, 2, { state: "CLOSED" }), fakeRow(world, 3)] });
  holdRepository(world, "o/code", { pulls: [pull(5, { merged: false, mergedAt: null }), pull(6)] });
  assert.deepEqual(host.rows!.openRowLabelsOf({ repo: "o/tracker", limit: 10, run: refused }), [{ number: 3, labels: [] }, { number: 1, labels: [{ name: "ready" }] }]);
  assert.deepEqual(host.rows!.openRowLabelsOf({ repo: "o/tracker", limit: 1, run: refused }).map((row) => row.number), [3], "at most `limit`, newest first");
  assert.deepEqual(host.rows!.openPullsNamingRowsOf({ repo: "o/code", limit: 10, run: refused }).map((p) => p.number), [5], "a merged pull request is not open");
  assert.throws(() => host.rows!.openRowLabelsOf({ repo: "o/unheld", limit: 10, run: refused }), /holds no rows of o\/unheld/);
  world.failures.set("openPullsNamingRowsOf o/code", new Error("HTTP 502"));
  assert.throws(() => host.rows!.openPullsNamingRowsOf({ repo: "o/code", limit: 10, run: refused }), /HTTP 502/);
  assert.equal(host.rows!.openRowLabelsOf({ repo: "o/tracker", limit: 10, run: refused }).length, 2, "refusing one repository's list refuses no other");
});

test("withRepositoryReads: rows by label carry their comments, a window of merged pull requests is read newest-updated first with files and merge commit, and the world's own repository is answered as before", () => {
  const host = withRepositoryReads(createFakeCodeHost());
  const world = host.rowsWorld;
  holdRepository(world, "o/tracker", { rows: [fakeRow(world, 1, { labels: ["in-progress"], comments: [{ id: 1, body: "claim", createdAt: "2026-10-04T10:00:00Z" }] }), fakeRow(world, 2, { labels: ["ready"] })] });
  const claimed = host.rows!.readRowsByLabel({ label: "in-progress", state: "OPEN", select: "number comments(first:100){nodes{body createdAt}}", repo: "o/tracker", run: refused });
  assert.deepEqual(claimed.map((row) => [row.number, row.comments.nodes.map((c: { body: string }) => c.body)]), [[1, ["claim"]]]);
  holdRepository(world, "o/code", { pulls: [pull(1, { updatedAt: "2026-10-04T13:00:00Z", files: [".acceptance/a.md"], mergeCommit: "a".repeat(40) }), pull(2, { updatedAt: "2026-10-04T12:30:00Z" }),
    pull(3, { updatedAt: "2026-10-03T00:00:00Z", mergedAt: "2026-10-03T00:00:00Z" })] });
  const window = host.rows!.readMergedPullRequests({ repo: "o/code", select: "number", run: refused, window: { since: "2026-10-04T00:00:00Z" } });
  assert.deepEqual(window.map((row) => row.number), [1, 2], "the one merged and last updated before the window is not in it");
  const [first] = host.rows!.readRowsSince({ ask: { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", repo: "o/code", select: "number", since: "2026-10-04T00:00:00Z" }, run: refused });
  assert.deepEqual([first.number, first.files.nodes, first.mergeCommit], [1, [{ path: ".acceptance/a.md" }], { oid: "a".repeat(40) }]);
  world.pulls.set(9, pull(9, { mergedAt: "2026-10-04T12:00:00Z" }));
  assert.ok(host.rows!.readMergedPullRequests({ repo: world.repo, select: "number", run: refused, window: { since: "2026-10-04T00:00:00Z" } }).some((row) => row.number === 9), "the world's own repository is the base fake's");
});

test("withRepositoryReads: a window longer than its pages is cut short, one that just fits is whole, and a repository is refused by the operation and repository `failures` names", () => {
  const host = withRepositoryReads(createFakeCodeHost());
  const world = host.rowsWorld;
  const many = (count: number) => Array.from({ length: count }, (_, i) => pull(i + 1, { updatedAt: "2026-10-04T12:00:00Z" }));
  const ask = { kind: "pullRequests" as const, states: ["MERGED" as const], orderBy: "UPDATED_AT" as const, repo: "o/code", select: "number", since: "2026-10-04T00:00:00Z", maxPages: 10 };
  holdRepository(world, "o/code", { pulls: many(1001) });
  assert.throws(() => host.rows!.readRowsSince({ ask, run: refused }), WindowCutShort);
  holdRepository(world, "o/code", { pulls: many(1000) });
  assert.equal(host.rows!.readRowsSince({ ask, run: refused }).length, 1000);
  world.failures.set("readRowsSince o/code", new Error("HTTP 502"));
  assert.throws(() => host.rows!.readRowsSince({ ask, run: refused }), /HTTP 502/);
  holdRepository(world, "o/other", { pulls: many(2) });
  assert.equal(host.rows!.readRowsSince({ ask: { ...ask, repo: "o/other" }, run: refused }).length, 2, "another repository is not refused with it");
  assert.throws(() => host.rows!.readRowsSince({ ask: { ...ask, repo: "o/unheld" }, run: refused }), /holds no pull requests of o\/unheld/);
});
