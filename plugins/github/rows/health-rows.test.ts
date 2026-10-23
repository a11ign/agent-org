// no-token: none -- every operation is handed a recorded `run` (or a stub that pages); nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 8): THE ARGUMENTS AND READINGS OF THE OPERATIONS THE ORG-HEALTH SWEEP, THE RELEASE ALARM AND THE RETRO ASK, which core's tests of those callers used to assert over a stubbed `gh` and which are the plugin's now (core's
 * tests run on the fake code host's rows and pull requests). Each case below was a case of `src/packaging/org-health.test.ts`, `org-health-access.test.ts`, `org-health-release-failed.test.ts`, `release-failure-alarm.test.ts`,
 * `org-retro-merged-repositories.test.ts` or `org-retro-read-cost.test.ts`, and keeps the assertion it had: the argument list is GitHub's own words, and so is how an answer is read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { changesetNamesOf, lastMergeTextOf, openPullsNamingRowsOf, openRowLabelsOf, releaseJobsOf, releaseRunsOf, teamRepositoriesTextOf } from "./health-rows.ts";
import { createRows } from "./index.ts";
import { recording } from "./recording-run.test.support.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);

// --- the org-health sweep ------------------------------------------------------------------------------------------------------------

test("a team's repositories are ONE paginated REST call for the declared org, projected to the repository and its six permission flags, and the text is handed back as it was printed", () => {
  const listing = "a11ign/a11ign\tfalse\ttrue\ttrue\ttrue\ttrue\n";
  const { asked, run } = recording(listing);
  assert.equal(teamRepositoriesTextOf({ org: "a11ign", team: "bots", run }), listing);
  assert.equal(asked.length, 1);
  assert.equal(asked[0][1], "orgs/a11ign/teams/bots/repos?per_page=100");
  assert.ok(asked[0].includes("--paginate"));
  assert.deepEqual(asked[0].slice(-2), ["--jq", ".[]|[.full_name,.permissions.admin,.permissions.maintain,.permissions.push,.permissions.triage,.permissions.pull]|@tsv"]);
  assert.throws(() => teamRepositoriesTextOf({ org: "a11ign", team: "bots", run: () => { throw new Error("gh: Not Found (HTTP 404)"); } }), /HTTP 404/, "a refusal throws, and the caller says why it could not read");
});

test("the last merge is read from the newest-UPDATED closed pull requests of ONE repository, printing the latest merged_at raw, and a refusal throws", () => {
  const { asked, run } = recording("2026-10-01T07:25:01Z\n");
  assert.equal(lastMergeTextOf({ repo: "a11ign/a11ign", window: 30, run }), "2026-10-01T07:25:01Z\n");
  assert.equal(asked.length, 1);
  assert.match(asked[0].join(" "), /repos\/a11ign\/a11ign\/pulls\?state=closed&sort=updated&direction=desc&per_page=30/);
  assert.deepEqual(asked[0].slice(-2), ["--jq", "[.[] | select(.merged_at != null) | .merged_at] | max"]);
  assert.equal(lastMergeTextOf({ repo: "a/b", window: 30, run: () => "null\n" }), "null\n", "`--jq` prints the word `null` for an empty list, and that is what the caller reads as no merge");
  assert.throws(() => lastMergeTextOf({ repo: "a/b", window: 30, run: () => { throw new Error("HTTP 403"); } }), /HTTP 403/);
});

// --- the release alarm ---------------------------------------------------------------------------------------------------------------

test("the release runs are the newest `window` runs of release.yml on main, projected to the run's id, event, status, conclusion, sha, times and url; an answer that is not JSON throws", () => {
  const runs = [{ id: 1, event: "push", status: "completed", conclusion: "success", sha: "abc", createdAt: "t", updatedAt: "u", url: "x" }];
  const { asked, run } = recording(runs);
  assert.deepEqual(releaseRunsOf({ repo: "a11ign/a11ign", window: 30, run }), runs);
  assert.deepEqual(asked[0].slice(0, 7), ["api", "--method", "GET", "repos/a11ign/a11ign/actions/workflows/release.yml/runs", "-f", "branch=main", "-f"]);
  assert.ok(asked[0].includes("per_page=30"));
  assert.equal(asked[0][asked[0].indexOf("--jq") + 1], "[.workflow_runs[] | {id, event, status, conclusion, sha: .head_sha, createdAt: .created_at, updatedAt: .updated_at, url: .html_url}]");
  assert.throws(() => releaseRunsOf({ repo: "r/r", window: 30, run: () => "not json" }), "a body that is not JSON is a throw, never an empty list");
  assert.deepEqual(releaseRunsOf({ repo: "r/r", window: 30, run: () => "{}" }), {}, "an object where a list was projected is handed back as it is: the caller refuses what is not a list");
  assert.throws(() => releaseRunsOf({ repo: "r/r", window: 30, run: () => { throw new Error("HTTP 403"); } }), /HTTP 403/);
});

test("a run's jobs are asked in the shape wanted: `named` is each job's name and conclusion, `failed` is the failed ones with the steps that failed", () => {
  const named = recording([{ name: "release / publish", conclusion: "success" }]);
  assert.deepEqual(releaseJobsOf({ repo: "a11ign/agent-org", runId: 5005, window: 100, shape: "named", run: named.run }), [{ name: "release / publish", conclusion: "success" }]);
  assert.equal(named.asked[0][1], "repos/a11ign/agent-org/actions/runs/5005/jobs?per_page=100");
  assert.equal(named.asked[0][named.asked[0].indexOf("--jq") + 1], "[.jobs[] | {name, conclusion}]");
  const failed = recording([{ id: 880001, name: "release", steps: ["Version the release"] }]);
  assert.deepEqual(releaseJobsOf({ repo: "a11ign/agent-org", runId: 5005, window: 100, shape: "failed", run: failed.run }), [{ id: 880001, name: "release", steps: ["Version the release"] }]);
  assert.equal(failed.asked[0][failed.asked[0].indexOf("--jq") + 1], "[.jobs[] | select(.conclusion == \"failure\") | {id, name, steps: [.steps[] | select(.conclusion == \"failure\") | .name]}]");
  assert.throws(() => releaseJobsOf({ repo: "r/r", runId: 1, window: 100, shape: "named", run: () => "oops" }));
});

test("the pending changesets are the names of the files in `.changeset/` on main, and a refusal or an answer that is not JSON throws", () => {
  const { asked, run } = recording(["README.md", "config.json", "a-change.md"]);
  assert.deepEqual(changesetNamesOf({ repo: "a11ign/agent-org", run }), ["README.md", "config.json", "a-change.md"]);
  assert.equal(asked[0][1], "repos/a11ign/agent-org/contents/.changeset?ref=main");
  assert.equal(asked[0][asked[0].indexOf("--jq") + 1], "[.[].name]");
  assert.throws(() => changesetNamesOf({ repo: "r/r", run: () => "not json" }));
  assert.throws(() => changesetNamesOf({ repo: "r/r", run: () => { throw new Error("HTTP 404"); } }), /HTTP 404/);
});

test("a failed release's incident: the job log is asked with escape sequences allowed, the lists are the incident-labelled issues without pull requests, and a list that cannot be read is `null`, never an empty one", () => {
  const log = recording("2026-10-11T08:42:11.0000000Z ERR_PNPM");
  assert.equal(rows().jobLogOf("a11ign/agent-org", 880001, log.run), "2026-10-11T08:42:11.0000000Z ERR_PNPM");
  assert.deepEqual(log.asked, [["api", "--allow-escape-sequences", "repos/a11ign/agent-org/actions/jobs/880001/logs"]], "gh refuses a response with terminal escape sequences, and a job log has them");
  assert.throws(() => rows().jobLogOf("r/r", 1, () => { throw new Error("HTTP 410"); }), /HTTP 410/);

  const closed = recording([{ number: 40, body: "Release-failure: a11ign/agent-org@5001" }]);
  assert.deepEqual(rows().closedIncidentsOf("a11ign/a11ign", closed.run), [{ number: 40, body: "Release-failure: a11ign/agent-org@5001" }]);
  assert.ok(closed.asked[0].includes("repos/a11ign/a11ign/issues") && closed.asked[0].includes("state=closed") && closed.asked[0].includes("labels=incident") && closed.asked[0].includes("per_page=100"));
  assert.equal(closed.asked[0][closed.asked[0].indexOf("--jq") + 1], "[.[] | select(.pull_request | not) | {number, body}]");
  assert.equal(rows().closedIncidentsOf("r/r", () => { throw new Error("HTTP 502"); }), null);
  assert.equal(rows().closedIncidentsOf("r/r", () => "not json"), null);
  assert.equal(rows().closedIncidentsOf("r/r", () => "{}"), null, "an object is not a list");
});

test("an incident is filed in the tracker it names, labelled `incident`; closing one is a comment and then the REST close, both in that tracker, and a refusal of either throws", () => {
  const filed = recording("");
  rows().createIncident("a11ign/a11ign", { title: "Release failed", body: "the body" }, filed.run);
  assert.deepEqual(filed.asked, [["issue", "create", "--repo", "a11ign/a11ign", "--title", "Release failed", "--label", "incident", "--body", "the body"]], "filed in the tracker it read, not in whichever repository the process stands in");
  const closed = recording("");
  rows().closeIncident("a11ign/a11ign", 41, "succeeded again", closed.run);
  assert.deepEqual(closed.asked, [["issue", "comment", "41", "--repo", "a11ign/a11ign", "--body", "succeeded again"],
    ["api", "--method", "PATCH", "repos/a11ign/a11ign/issues/41", "-f", "state=closed", "-f", "state_reason=completed"]]);
  assert.throws(() => rows().createIncident("r/r", { title: "t", body: "b" }, () => { throw new Error("HTTP 403"); }), /HTTP 403/);
  assert.throws(() => rows().closeIncident("r/r", 1, "c", () => { throw new Error("HTTP 403"); }), /HTTP 403/);
});

// --- the retro -----------------------------------------------------------------------------------------------------------------------

test("a tracker's open rows are the newest `limit` open issues of the repository named, with their number and labels, and an answer that is not JSON throws", () => {
  const { asked, run } = recording([{ number: 4001, labels: [{ name: "in-progress" }] }]);
  assert.deepEqual(openRowLabelsOf({ repo: "o/tracker", limit: 1000, run }), [{ number: 4001, labels: [{ name: "in-progress" }] }]);
  assert.deepEqual(asked, [["issue", "list", "-R", "o/tracker", "--state", "open", "--limit", "1000", "--json", "number,labels"]], "`-R` names the repository: a read with none answers for the working directory's alone");
  assert.throws(() => openRowLabelsOf({ repo: "r/r", limit: 10, run: () => "not json" }));
  assert.throws(() => openRowLabelsOf({ repo: "r/r", limit: 10, run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
});

test("a code repository's open pull requests are the newest `limit`, with the number, body, branch and labels a row is named by, in the repository named", () => {
  const { asked, run } = recording([{ number: 9, body: "Closes o/tracker#4001", headRefName: "agent/more-4001", labels: [] }]);
  assert.deepEqual(openPullsNamingRowsOf({ repo: "o/other", limit: 1000, run }), [{ number: 9, body: "Closes o/tracker#4001", headRefName: "agent/more-4001", labels: [] }]);
  assert.deepEqual(asked, [["pr", "list", "-R", "o/other", "--state", "open", "--limit", "1000", "--json", "number,body,headRefName,labels"]]);
  assert.throws(() => openPullsNamingRowsOf({ repo: "r/r", limit: 10, run: () => "not json" }));
});

/** A GraphQL connection of `count` merged pull requests, newest-updated first, `size` to a page: the `after` cursor of the call says which page is wanted. */
function connectionPages(count: number, size = 100) {
  const asked: string[][] = [];
  const all = Array.from({ length: count }, (_, i) => ({ number: i + 1, mergedAt: "2026-10-04T12:00:00Z", updatedAt: "2026-10-04T12:00:00Z", createdAt: "2026-10-04T11:00:00Z" }));
  const run = (args: string[]): string => {
    asked.push(args);
    const after = args.find((arg) => arg.startsWith("after="))?.slice("after=".length);
    const from = after === undefined ? 0 : Number(after);
    const nodes = all.slice(from, from + size);
    return JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: from + size < count, endCursor: String(from + size) }, nodes } } } });
  };
  return { asked, run };
}
const SINCE = "2026-10-04T00:22:00Z";

test("the merged pull requests of a window are the `pullRequests` connection of the repository NAMED IN ITS VARIABLES, paged until a row falls before the window, and never a search", () => {
  const pages = connectionPages(150);
  const merged = rows().readMergedPullRequests({ repo: "a11ign/agent-org", select: "number createdAt", run: pages.run, window: { since: SINCE } });
  assert.equal(merged.length, 150, "the read pages past one page of a hundred");
  assert.equal(pages.asked.length, 2);
  const first = pages.asked[0];
  assert.deepEqual([first[0], first[1]], ["api", "graphql"]);
  assert.ok(first.includes("owner=a11ign") && first.includes("name=agent-org"), "the repository is named in the variables: a read with none would answer for the working directory's repository only");
  const query = first.find((arg) => arg.startsWith("query=")) ?? "";
  assert.match(query, /pullRequests\(states:\[MERGED\],first:100,after:\$after,orderBy:\{field:UPDATED_AT,direction:DESC\}\)/);
  assert.ok(pages.asked.every((args) => !args.includes("--search") && !args.includes("--limit") && !args.includes("--label")), "and none is a search");
  assert.ok(pages.asked[1].includes("after=100"), "the second page is asked from the first's cursor");
});

test("a window of more rows than the pages hold throws the code host's `WindowCutShort` (the caller says it hit the read limit), and a row merged before the window is dropped by its own mergedAt", () => {
  const helpers = rowsReadHelpers() as unknown as RowsHelpers;
  const limit = 1000;
  assert.throws(() => rows().readMergedPullRequests({ repo: "a/b", select: "number", run: connectionPages(limit + 1).run, window: { since: SINCE, maxPages: limit / 100 } }), helpers.WindowCutShort);
  assert.equal(rows().readMergedPullRequests({ repo: "a/b", select: "number", run: connectionPages(limit).run, window: { since: SINCE, maxPages: limit / 100 } }).length, limit, "CONTROL: exactly the pages' worth is a complete read");
  const old = { number: 9, mergedAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-04T12:00:00Z", createdAt: "2026-10-02T00:00:00Z" };
  const fresh = { number: 1, mergedAt: "2026-10-04T12:00:00Z", updatedAt: "2026-10-04T12:00:00Z", createdAt: "2026-10-04T11:00:00Z" };
  const page = JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [fresh, old] } } } });
  assert.deepEqual(rows().readMergedPullRequests({ repo: "a/b", select: "number", run: () => page, window: { since: SINCE } }).map((row) => row.number), [1], "updated inside the window and merged before it: read, and not counted");
  assert.throws(() => rows().readMergedPullRequests({ repo: "a/b", select: "number", run: () => "not a connection", window: { since: SINCE } }), "a payload that is not a connection is a throw, never an empty list");
  assert.throws(() => rows().readMergedPullRequests({ repo: "a/b", select: "number", run: () => { throw new Error("HTTP 502"); }, window: { since: SINCE } }), /HTTP 502/);
});
