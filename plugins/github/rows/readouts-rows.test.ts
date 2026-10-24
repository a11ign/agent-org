// no-token: none -- every operation is handed a stub `run` that records the argument list; nothing here spawns `gh` or reaches the network
/**
 * A11-160 (step 9): THE READ-ONLY REPORTERS' OPERATIONS AND WHAT THEY SAY TO `gh`. The reporters (`src/blast-radius.ts`, `ci-health-liveness.ts`, `release-behind-main.ts`, `review-depth.ts`, `workflow-run-liveness.ts`,
 * `lane-ownership.ts`, `branch-inventory-report.ts`) decide what a tree, a schedule, a release, a diff or an inventory means; their core tests run on the fake code host's world. What only GitHub's words can assert is held
 * here: the argument list of each read, in the order the callers built it (copied from the base code, so a changed command fails), how GitHub's answer is read, and what is thrown when it is not what was asked for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRows } from "./index.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import {
  commitAssociatedPullsOf, commitFilesOf, commitPullsOf, issueProjectionOf, openPullHeadRefsOf, pathCommitsPageOf, publishedReleasesOf, pullDepthFactsOf, pullFilenamesOf, pullFilenamesPageOf,
  rawFileTextOf, reportCommentBodiesOf, restRowBodyOf, rowTimelineEventsOf, scheduledRunsOf, treeFilesOf, workflowDefinitionOf,
} from "./readouts-reads.ts";
import { recording } from "./recording-run.test.support.ts";

// --- the blast-radius gate ------------------------------------------------------------------------------------------------------------

test("the tree of a repository is its default branch's recursive tree, the blobs' paths one per line; a truncated tree is the jq's own error, thrown", () => {
  const { run, asked } = recording("src/a.ts\nsrc/b.ts\n");
  assert.deepEqual(treeFilesOf({ repo: "a11ign/agent-org", run }), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(asked, [["api", "repos/a11ign/agent-org/git/trees/HEAD?recursive=1", "--jq", 'if .truncated then error("tree truncated") else .tree[] | select(.type == "blob") | .path end']]);
  assert.deepEqual(treeFilesOf({ repo: "r/r", run: () => "" }), [], "a tree with no blob is an empty list; a refusal is the next case");
  assert.throws(() => treeFilesOf({ repo: "r/r", run: () => { throw new Error("jq: error: tree truncated"); } }), /tree truncated/);
});

// --- the CI-health liveness -----------------------------------------------------------------------------------------------------------

test("the workflow is read from `actions/workflows/<file>`, its file raw from `contents/<path>`, its schedule runs with `event=schedule` and the page size asked", () => {
  const seen: string[][] = [];
  const answers: Record<string, string> = {
    "repos/a/b/actions/workflows/ci-health.yml": JSON.stringify({ state: "active", path: ".github/workflows/ci-health.yml" }),
    "repos/a/b/contents/.github/workflows/ci-health.yml": 'on:\n  schedule:\n    - cron: "43 6 * * 1"\n',
    "repos/a/b/actions/workflows/ci-health.yml/runs?event=schedule&per_page=100": JSON.stringify({ workflow_runs: [{ id: 1, event: "schedule" }] }),
  };
  const run = (args: string[]): string => { seen.push(args); return answers[args.find((arg) => arg.startsWith("repos/"))!]; };
  assert.deepEqual(workflowDefinitionOf({ repo: "a/b", workflow: "ci-health.yml", run }), { state: "active", path: ".github/workflows/ci-health.yml" });
  assert.equal(rawFileTextOf({ repo: "a/b", path: ".github/workflows/ci-health.yml", run }), 'on:\n  schedule:\n    - cron: "43 6 * * 1"\n');
  assert.deepEqual(scheduledRunsOf({ repo: "a/b", workflow: "ci-health.yml", perPage: 100, run }), [{ id: 1, event: "schedule" }]);
  assert.deepEqual(seen, [
    ["api", "repos/a/b/actions/workflows/ci-health.yml"],
    ["api", "repos/a/b/contents/.github/workflows/ci-health.yml", "-H", "Accept: application/vnd.github.raw"],
    ["api", "repos/a/b/actions/workflows/ci-health.yml/runs?event=schedule&per_page=100"],
  ]);
});

test("a workflow answer that is not JSON throws, and a runs answer with no `workflow_runs` is `undefined`, not an empty list", () => {
  assert.throws(() => workflowDefinitionOf({ repo: "a/b", workflow: "w.yml", run: () => "<html>" }), SyntaxError);
  assert.throws(() => scheduledRunsOf({ repo: "a/b", workflow: "w.yml", perPage: 100, run: () => "<html>" }), SyntaxError);
  assert.equal(scheduledRunsOf({ repo: "a/b", workflow: "w.yml", perPage: 100, run: () => "{}" }), undefined);
});

test("the report issue's comments are every page, slurped, from the slot on when one is named, and flattened to their bodies", () => {
  const pages = JSON.stringify([[{ body: "one" }, { body: "two" }], [{ body: "three" }]]);
  const { run, asked } = recording(pages);
  assert.deepEqual(reportCommentBodiesOf({ repo: "a/b", issue: 928, perPage: 100, since: "2026-10-05T06:43:00Z", run }), ["one", "two", "three"]);
  assert.deepEqual(reportCommentBodiesOf({ repo: "a/b", issue: 928, perPage: 100, since: null, run }), ["one", "two", "three"]);
  assert.deepEqual(asked, [
    ["api", "--paginate", "--slurp", "repos/a/b/issues/928/comments?per_page=100&since=2026-10-05T06:43:00Z"],
    ["api", "--paginate", "--slurp", "repos/a/b/issues/928/comments?per_page=100"],
  ]);
  assert.throws(() => reportCommentBodiesOf({ repo: "a/b", issue: 1, perPage: 100, since: null, run: () => "{}" }), TypeError, "an answer that is not a list of pages is not read as no comments");
});

// --- release-behind-main --------------------------------------------------------------------------------------------------------------

test("the releases are the newest `window` that are not drafts, asked with `--method GET` and `-f per_page`, projected by the jq; the listing must be a list", () => {
  const { run, asked } = recording([{ tag: "v1", at: "2026-10-01T00:00:00Z" }]);
  assert.deepEqual(publishedReleasesOf({ repo: "a/b", window: 10, run }), [{ tag: "v1", at: "2026-10-01T00:00:00Z" }]);
  assert.deepEqual(asked, [["api", "--method", "GET", "repos/a/b/releases", "-f", "per_page=10", "--jq", "[.[] | select(.draft | not) | {tag: .tag_name, at: .published_at}]"]]);
  assert.throws(() => publishedReleasesOf({ repo: "a/b", window: 10, run: () => "<html>rate limited</html>" }), SyntaxError);
  assert.throws(() => publishedReleasesOf({ repo: "a/b", window: 10, run: () => "{}" }), /^Error: a\/b releases did not answer a list$/);
});

test("a page of the commits of `main` under a path asks the path, the page, the page size and `since` last when one is named, and projects sha, time and parent count", () => {
  const { run, asked } = recording([{ sha: "s1", at: "2026-10-08T09:45:15Z", parents: 1 }]);
  assert.deepEqual(pathCommitsPageOf({ repo: "a/b", path: "src/", page: 2, perPage: 100, since: "2026-10-06T05:28:37Z", run }), [{ sha: "s1", at: "2026-10-08T09:45:15Z", parents: 1 }]);
  pathCommitsPageOf({ repo: "a/b", path: "src/", page: 1, perPage: 100, since: null, run });
  const jq = "[.[] | {sha, at: .commit.committer.date, parents: (.parents | length)}]";
  assert.deepEqual(asked, [
    ["api", "--method", "GET", "repos/a/b/commits", "-f", "sha=main", "-f", "path=src/", "-f", "per_page=100", "-f", "page=2", "-f", "since=2026-10-06T05:28:37Z", "--jq", jq],
    ["api", "--method", "GET", "repos/a/b/commits", "-f", "sha=main", "-f", "path=src/", "-f", "per_page=100", "-f", "page=1", "--jq", jq],
  ]);
  assert.throws(() => pathCommitsPageOf({ repo: "a/b", path: "src/", page: 1, perPage: 100, since: null, run: () => "{}" }), /^Error: a\/b commits under src\/ did not answer a list$/);
});

test("the files and the pull requests of one commit are two projections of `commits/<sha>`; each must be a list and names the commit when it is not", () => {
  const files = recording([{ filename: "src/a.ts" }, { filename: "docs/x.md", previous_filename: "src/x.ts" }]);
  assert.deepEqual(commitFilesOf({ repo: "a/b", sha: "abc", run: files.run }), [{ filename: "src/a.ts" }, { filename: "docs/x.md", previous_filename: "src/x.ts" }]);
  assert.deepEqual(files.asked, [["api", "repos/a/b/commits/abc", "--jq", "[.files[] | {filename, previous_filename}]"]]);
  const pulls = recording([{ number: 25, body: "no changeset" }]);
  assert.deepEqual(commitPullsOf({ repo: "a/b", sha: "abc", run: pulls.run }), [{ number: 25, body: "no changeset" }]);
  assert.deepEqual(pulls.asked, [["api", "repos/a/b/commits/abc/pulls", "--jq", "[.[] | {number, body}]"]]);
  assert.throws(() => commitFilesOf({ repo: "a/b", sha: "abc", run: () => "{}" }), /^Error: a\/b commit abc did not answer a list$/);
  assert.throws(() => commitPullsOf({ repo: "a/b", sha: "abc", run: () => "{}" }), /^Error: a\/b pulls of abc did not answer a list$/);
});

// --- the review depth -----------------------------------------------------------------------------------------------------------------

test("a pull request's depth facts are its counts as numbers and its title and body as text, from one `pulls/<n>` read; an absent count is NaN and an absent text is empty", () => {
  const { run, asked } = recording({ changed_files: 2, additions: 9, deletions: 3, title: "t", body: "Closes #42" });
  assert.deepEqual(pullDepthFactsOf({ repo: "a/b", number: 5, run }), { changedFiles: 2, additions: 9, deletions: 3, title: "t", body: "Closes #42" });
  assert.deepEqual(asked, [["api", "repos/a/b/pulls/5"]]);
  const bare = pullDepthFactsOf({ repo: "a/b", number: 5, run: () => "{}" });
  assert.deepEqual([Number.isNaN(bare.changedFiles), Number.isNaN(bare.additions), Number.isNaN(bare.deletions), bare.title, bare.body], [true, true, true, "", ""]);
  assert.throws(() => pullDepthFactsOf({ repo: "a/b", number: 5, run: () => "<html>" }), SyntaxError);
});

test("the first page of a pull request's files is `pulls/<n>/files?per_page=<n>`, answered as file names; a row's body is `issues/<n>` over REST, empty when it has none", () => {
  const files = recording([{ filename: "docs/a.md" }, { filename: "src/a.test.ts" }]);
  assert.deepEqual(pullFilenamesPageOf({ repo: "a/b", number: 5, perPage: 100, run: files.run }), ["docs/a.md", "src/a.test.ts"]);
  assert.deepEqual(files.asked, [["api", "repos/a/b/pulls/5/files?per_page=100"]]);
  assert.throws(() => pullFilenamesPageOf({ repo: "a/b", number: 5, perPage: 100, run: () => "{}" }), TypeError);
  const row = recording({ body: "## Region\n" });
  assert.equal(restRowBodyOf({ repo: "a/b", number: 42, run: row.run }), "## Region\n");
  assert.equal(restRowBodyOf({ repo: "a/b", number: "0042", run: row.run }), "## Region\n");
  assert.deepEqual(row.asked, [["api", "repos/a/b/issues/42"], ["api", "repos/a/b/issues/0042"]], "the number is spelled as the caller gave it");
  assert.equal(restRowBodyOf({ repo: "a/b", number: 1, run: () => JSON.stringify({ body: null }) }), "");
  assert.equal(restRowBodyOf({ repo: "a/b", number: 1, run: () => "{}" }), "");
});

// --- the commit-liveness watchdog and the lane authorship check -----------------------------------------------------------------------

test("the pull requests of a commit are `commits/<sha>/pulls`, answered as number and head sha; an answer that is not a list is thrown", () => {
  const { run, asked } = recording([{ number: 205, head: { sha: "new00000" } }, { number: 90, head: { sha: "old00000" } }]);
  assert.deepEqual(commitAssociatedPullsOf({ repo: "a/b", sha: "abc", run }), [{ number: 205, headRefOid: "new00000" }, { number: 90, headRefOid: "old00000" }]);
  assert.deepEqual(asked, [["api", "repos/a/b/commits/abc/pulls"]]);
  assert.deepEqual(commitAssociatedPullsOf({ repo: "a/b", sha: "abc", run: () => "[]" }), [], "no pull request is an empty list; a refusal is thrown");
  assert.throws(() => commitAssociatedPullsOf({ repo: "a/b", sha: "abc", run: () => "{}" }), TypeError);
});

test("every file of a pull request is read through `--paginate` with the jq printing one name a line, and blank lines are dropped", () => {
  const { run, asked } = recording("src/a.ts\n\n.github/workflows/ci.yml\n");
  assert.deepEqual(pullFilenamesOf({ repo: "a/b", number: "9", run }), ["src/a.ts", ".github/workflows/ci.yml"]);
  assert.deepEqual(asked, [["api", "--paginate", "repos/a/b/pulls/9/files", "--jq", ".[].filename"]]);
  assert.throws(() => pullFilenamesOf({ repo: "a/b", number: 9, run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
});

// --- the branch inventory -------------------------------------------------------------------------------------------------------------

test("the open pull requests' branches are one `--paginate` REST read of the head refs, a line each", () => {
  const { run, asked } = recording("agent/a-1\n  \nagent/b-2\n");
  assert.deepEqual(openPullHeadRefsOf({ repo: "a/b", run }), ["agent/a-1", "agent/b-2"]);
  assert.deepEqual(asked, [["api", "repos/a/b/pulls?state=open&per_page=100", "--paginate", "--jq", ".[].head.ref"]]);
});

test("the issues listing is projected to four fields a line by the jq, state upper-cased, pull requests carried and not filtered, and a line that is not JSON throws", () => {
  const lines = ['{"number":7,"state":"closed","isPullRequest":false,"labels":["backlog"]}', "", '{"number":137,"state":"open","isPullRequest":true,"labels":[]}'].join("\n");
  const { run, asked } = recording(lines);
  assert.deepEqual(issueProjectionOf({ repo: "a/b", run }), [
    { number: 7, state: "CLOSED", isPullRequest: false, labels: ["backlog"] },
    { number: 137, state: "OPEN", isPullRequest: true, labels: [] },
  ]);
  assert.deepEqual(asked, [["api", "repos/a/b/issues?state=all&per_page=100", "--paginate", "--jq", '.[] | {number, state, isPullRequest: has("pull_request"), labels: [.labels[].name]}']]);
  assert.throws(() => issueProjectionOf({ repo: "a/b", run: () => "not json" }), SyntaxError);
});

test("a row's timeline is every page of `issues/<n>/timeline`, parsed as it came", () => {
  const { run, asked } = recording([{ event: "labeled", label: { name: "session:worker-audit" } }]);
  assert.deepEqual(rowTimelineEventsOf({ repo: "a/b", number: 119, run }), [{ event: "labeled", label: { name: "session:worker-audit" } }]);
  assert.deepEqual(asked, [["api", "repos/a/b/issues/119/timeline", "--paginate"]]);
  assert.throws(() => rowTimelineEventsOf({ repo: "a/b", number: 119, run: () => "<html>" }), SyntaxError);
});

// --- the section as the code host's rows --------------------------------------------------------------------------------------------------

test("the code host's rows carry every operation of the section, and the probe is refused when the host was built with no runner of its own", () => {
  const rows = createRows(() => ({ ...rowsReadHelpers } as never));
  for (const name of ["treeFilesOf", "workflowDefinitionOf", "rawFileTextOf", "scheduledRunsOf", "reportCommentBodiesOf", "publishedReleasesOf", "pathCommitsPageOf", "commitFilesOf", "commitPullsOf", "pullDepthFactsOf",
    "pullFilenamesPageOf", "restRowBodyOf", "commitAssociatedPullsOf", "pullFilenamesOf", "openPullHeadRefsOf", "issueProjectionOf", "rowTimelineEventsOf", "conditionalProbeOf"] as const) {
    assert.equal(typeof rows[name], "function", name);
  }
  assert.throws(() => rows.conditionalProbeOf({ path: "p", etag: undefined, timeoutMs: 1, maxBuffer: 1 }), /no runner of their own/);
});
