// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 9): THE ARGUMENTS AND READINGS OF THE OPERATIONS THE READY-LABEL AUDIT, THE RETRO'S UNWAITED-STOCK COUNT, THE UN-PARK OF SATISFIED ROWS AND THE TICK'S HEARTBEAT ASK, which core's tests of those callers used to
 * assert over a stubbed `gh` and which are the plugin's now (core's tests run on the fake code host's rows). The argument lists are copied from the callers they were moved from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockedByAddedAtOf, closedAtOf, closingIssueReferencesOf, closingReferencesOf, issueListingOf, latestReopenedAtOf, mergedClosersOf, milestoneDescriptionOf, newestCommentAtOf, newestLabeledAtOf, pullListingOf,
  reportedOpenIssueNumbersOf, rowLabelsAndStateOf, stockTimelineEventsOf, writeHeartbeatVariable,
} from "./audit-reads.ts";

/** A `run` that records the argument list it was given and answers `answer`. */
const recording = (answer: string) => {
  const seen: string[][] = [];
  return { seen, run: (args: string[]): string => { seen.push(args); return answer; } };
};

const refusing = (args: string[]): string => {
  throw new Error(`HTTP 502 on ${args[0]}`);
};

test("the numbers GitHub reports open: the search index asked for the repository's open ISSUES, every page, one number per line; a line that is not a number is unreadable, and a refusal throws", () => {
  const { seen, run } = recording("7\n12\n\n3\n");
  assert.deepEqual(reportedOpenIssueNumbersOf({ repo: "a11ign/a11ign", run }), { numbers: [7, 12, 3] });
  assert.deepEqual(seen, [["api", `search/issues?q=${encodeURIComponent("repo:a11ign/a11ign is:issue is:open")}`, "--paginate", "--jq", ".items[].number"]]);
  assert.deepEqual(reportedOpenIssueNumbersOf({ repo: "r/r", run: () => "" }), { numbers: [] }, "a read that worked and found none is the empty list");
  assert.deepEqual(reportedOpenIssueNumbersOf({ repo: "r/r", run: () => "7\nnot a number\n" }), { unreadable: "GitHub's reported open-issue numbers included a non-number line -- refusing to guess. Got: not a number" });
  assert.throws(() => reportedOpenIssueNumbersOf({ repo: "r/r", run: refusing }), /HTTP 502/);
});

test("an issue listing is `gh issue list` in the repository, the state, the limit and the fields it is asked for, with a milestone filter after them; the rows carry those fields and the labels as their names", () => {
  const { seen, run } = recording(JSON.stringify([{ number: 4, title: "t", labels: [{ name: "ready" }, { name: "lane:any" }], state: "OPEN", extra: 1 }]));
  assert.deepEqual(issueListingOf({ repo: "a11ign/a11ign", state: "open", limit: 200, fields: ["number", "title", "labels", "state"], what: "open issues", run }),
    { rows: [{ number: 4, title: "t", labels: ["ready", "lane:any"], state: "OPEN" }] });
  assert.deepEqual(seen, [["issue", "list", "--repo", "a11ign/a11ign", "--state", "open", "--limit", "200", "--json", "number,title,labels,state"]]);
  const closed = recording("[]");
  issueListingOf({ repo: "r/r", state: "closed", limit: 500, fields: ["number", "title", "closedAt", "stateReason"], what: "closed issues", run: closed.run });
  assert.deepEqual(closed.seen, [["issue", "list", "--repo", "r/r", "--state", "closed", "--limit", "500", "--json", "number,title,closedAt,stateReason"]]);
  const milestoned = recording("[]");
  issueListingOf({ repo: "r/r", state: "open", limit: 500, fields: ["number"], milestone: "Out of release", what: "out-of-release rows", run: milestoned.run });
  assert.deepEqual(milestoned.seen, [["issue", "list", "--repo", "r/r", "--state", "open", "--limit", "500", "--json", "number", "--milestone", "Out of release"]]);
  const edges = recording("[]");
  issueListingOf({ repo: "r/r", state: "open", limit: 500, fields: ["number", "title", "body", "labels", "blockedBy"], what: "open issues", run: edges.run });
  assert.deepEqual(edges.seen, [["issue", "list", "--repo", "r/r", "--state", "open", "--limit", "500", "--json", "number,title,body,labels,blockedBy"]]);
  assert.deepEqual(issueListingOf({ repo: "r/r", state: "all", limit: 5, fields: ["number", "body", "blockedBy"], what: "x", run: () => JSON.stringify([{ number: 1 }, { number: 2, body: "b", blockedBy: { totalCount: 1 } }]) }),
    { rows: [{ number: 1 }, { number: 2, body: "b", blockedBy: { totalCount: 1 } }] }, "a field the listing left out is absent, not null: an edge list that was not read is not an empty one");
});

test("an issue listing that is not one is unreadable in the words the audit refuses in; a label with no name is too; a refusal throws", () => {
  const unreadable = (answer: string) => issueListingOf({ repo: "r/r", state: "open", limit: 5, fields: ["number", "labels"], what: "open issues", run: () => answer });
  assert.deepEqual(unreadable("<html>502"), { unreadable: "gh's open issues response was not JSON -- refusing to guess. First 200 chars: <html>502" });
  assert.deepEqual(unreadable('{"message":"x"}'), { unreadable: 'gh\'s open issues response was not a list -- refusing to guess. Got: {"message":"x"}' });
  assert.deepEqual(unreadable(JSON.stringify([{ number: 9, labels: [{ name: "a" }, {}] }])), { unreadable: "issue #9 has a label with no name -- refusing to guess. Got: {}" });
  assert.throws(() => issueListingOf({ repo: "r/r", state: "open", limit: 5, fields: ["number"], what: "open issues", run: refusing }), /HTTP 502/);
});

test("a pull request listing is `gh pr list` in the repository, state, limit and fields asked, and carries those fields", () => {
  const open = recording(JSON.stringify([{ number: 3, body: "Closes #4", headRefName: "agent/x", labels: [] }]));
  assert.deepEqual(pullListingOf({ repo: "a11ign/a11ign", state: "open", limit: 500, fields: ["number", "body", "headRefName"], what: "open PRs", run: open.run }), { rows: [{ number: 3, body: "Closes #4", headRefName: "agent/x" }] });
  assert.deepEqual(open.seen, [["pr", "list", "--repo", "a11ign/a11ign", "--state", "open", "--limit", "500", "--json", "number,body,headRefName"]]);
  const closed = recording(JSON.stringify([{ number: 5, mergedAt: null }]));
  assert.deepEqual(pullListingOf({ repo: "r/r", state: "closed", limit: 1000, fields: ["number", "mergedAt"], what: "closed PRs", run: closed.run }), { rows: [{ number: 5, mergedAt: null }] });
  assert.deepEqual(closed.seen, [["pr", "list", "--repo", "r/r", "--state", "closed", "--limit", "1000", "--json", "number,mergedAt"]]);
  assert.deepEqual(pullListingOf({ repo: "r/r", state: "open", limit: 5, fields: ["number"], what: "open PRs", run: () => "nope" }), { unreadable: "gh's open PRs response was not JSON -- refusing to guess. First 200 chars: nope" });
  assert.throws(() => pullListingOf({ repo: "r/r", state: "open", limit: 5, fields: ["number"], what: "open PRs", run: refusing }), /HTTP 502/);
});

test("the closing references of issues are ONE aliased GraphQL query of the repository, each issue's `closedByPullRequestsReferences`; no issue makes no call", () => {
  const { seen, run } = recording(JSON.stringify({ data: { repository: {
    i0: { number: 7, closedByPullRequestsReferences: { nodes: [{ number: 9, state: "MERGED", mergedAt: "2026-10-01T00:00:00Z" }, { number: 10, state: "CLOSED" }] } },
    i1: { number: 8, closedByPullRequestsReferences: { nodes: null } } } } }));
  assert.deepEqual(closingReferencesOf({ repo: "a11ign/a11ign", numbers: [7, 8], run }), { references: new Map([
    [7, [{ number: 9, state: "MERGED", mergedAt: "2026-10-01T00:00:00Z" }, { number: 10, state: "CLOSED", mergedAt: null }]], [8, []]]) });
  assert.deepEqual(seen, [["api", "graphql", "-f", 'query={ repository(owner: "a11ign", name: "a11ign") { '
    + "i0: issue(number: 7) { number closedByPullRequestsReferences(first: 20) { nodes { number state mergedAt } } } "
    + "i1: issue(number: 8) { number closedByPullRequestsReferences(first: 20) { nodes { number state mergedAt } } } } }"]]);
  const none = recording("");
  assert.deepEqual(closingReferencesOf({ repo: "r/r", numbers: [], run: none.run }), { references: new Map() });
  assert.deepEqual(none.seen, [], "nothing to ask needs no round trip");
});

test("an aliased answer that is not the shape asked for is unreadable in the words the audit refuses in, and a refusal throws", () => {
  const references = (answer: string) => closingReferencesOf({ repo: "o/n", numbers: [7], run: () => answer });
  assert.deepEqual(references("<html>"), { unreadable: "gh's closing-references response was not JSON -- refusing to guess. First 200 chars: <html>" });
  assert.deepEqual(references("{}"), { unreadable: "gh's closing-references response had no repository -- refusing to guess. Got: {}" });
  assert.deepEqual(references(JSON.stringify({ data: { repository: {} } })), { unreadable: "issue #7 is missing from the closing-references response -- refusing to guess. Got: null" });
  assert.throws(() => closingReferencesOf({ repo: "o/n", numbers: [7], run: refusing }), /HTTP 502/);
});

test("the latest reopen of issues is the last `ReopenedEvent` of each, in one aliased query; none is `null`", () => {
  const { seen, run } = recording(JSON.stringify({ data: { repository: {
    i0: { number: 7, timelineItems: { nodes: [{ createdAt: "2026-10-01T00:00:00Z" }, { createdAt: "2026-10-05T00:00:00Z" }] } }, i1: { number: 8, timelineItems: { nodes: [] } } } } }));
  assert.deepEqual(latestReopenedAtOf({ repo: "a11ign/a11ign", numbers: [7, 8], run }), { reopenedAt: new Map([[7, "2026-10-05T00:00:00Z"], [8, null]]) });
  assert.deepEqual(seen, [["api", "graphql", "-f", 'query={ repository(owner: "a11ign", name: "a11ign") { '
    + "i0: issue(number: 7) { number timelineItems(itemTypes: [REOPENED_EVENT], last: 1) { nodes { ... on ReopenedEvent { createdAt } } } } "
    + "i1: issue(number: 8) { number timelineItems(itemTypes: [REOPENED_EVENT], last: 1) { nodes { ... on ReopenedEvent { createdAt } } } } } }"]]);
  assert.deepEqual(latestReopenedAtOf({ repo: "o/n", numbers: [7], run: () => JSON.stringify({ data: { repository: {} } }) }), { unreadable: "issue #7 is missing from the reopen-history response -- refusing to guess. Got: null" });
});

test("the issues a pull request declares it closes are read from the PULL REQUEST's side, in one aliased query", () => {
  const { seen, run } = recording(JSON.stringify({ data: { repository: { p0: { number: 30, closingIssuesReferences: { nodes: [{ number: 7 }, { number: "x" }, { number: 8 }] } } } } }));
  assert.deepEqual(closingIssueReferencesOf({ repo: "a11ign/a11ign", numbers: [30], run }), { references: new Map([[30, [7, 8]]]) });
  assert.deepEqual(seen, [["api", "graphql", "-f", 'query={ repository(owner: "a11ign", name: "a11ign") { '
    + "p0: pullRequest(number: 30) { number closingIssuesReferences(first: 20) { nodes { number } } } } }"]]);
  assert.deepEqual(closingIssueReferencesOf({ repo: "o/n", numbers: [30], run: () => JSON.stringify({ data: { repository: {} } }) }), { unreadable: "PR #30 is missing from the closing-issue-references response -- refusing to guess. Got: null" });
});

test("when a label was last put on a row and when its newest comment was made: one paginated read each, trimmed; no event and no comment are `null` (jq prints the text `null` for an empty selection)", () => {
  const labeled = recording("2026-10-09T21:29:49Z\n");
  assert.equal(newestLabeledAtOf({ repo: "a11ign/a11ign", number: 7, label: "in-progress", run: labeled.run }), "2026-10-09T21:29:49Z");
  assert.deepEqual(labeled.seen, [["api", "repos/a11ign/a11ign/issues/7/timeline", "--paginate", "--jq", '[.[]|select(.event=="labeled" and .label.name=="in-progress")]|last|.created_at']]);
  assert.equal(newestLabeledAtOf({ repo: "r/r", number: 7, label: "x", run: () => "null\n" }), null);
  const commented = recording("2026-10-10T00:00:00Z\n");
  assert.equal(newestCommentAtOf({ repo: "a11ign/a11ign", number: 7, run: commented.run }), "2026-10-10T00:00:00Z");
  assert.deepEqual(commented.seen, [["api", "repos/a11ign/a11ign/issues/7/comments", "--paginate", "--jq", "[.[].created_at]|last"]]);
  assert.equal(newestCommentAtOf({ repo: "r/r", number: 7, run: () => "null" }), null);
  assert.equal(newestCommentAtOf({ repo: "r/r", number: 7, run: () => "" }), null);
  assert.throws(() => newestCommentAtOf({ repo: "r/r", number: 7, run: refusing }), /HTTP 502/);
  assert.throws(() => newestLabeledAtOf({ repo: "r/r", number: 7, label: "x", run: refusing }), /HTTP 502/);
});

test("a milestone's description: the repository's milestones in any state, the one titled so; none and a description of none are `null`; an answer that is not JSON throws", () => {
  const { seen, run } = recording(JSON.stringify([{ title: "v1", description: "one" }, { title: "Out of release", description: "the rule" }, { title: "v2", description: null }]));
  assert.equal(milestoneDescriptionOf({ repo: "a11ign/a11ign", title: "Out of release", run }), "the rule");
  assert.deepEqual(seen, [["api", "repos/a11ign/a11ign/milestones?state=all", "--jq", "[.[]|{title,description}]"]]);
  assert.equal(milestoneDescriptionOf({ repo: "r/r", title: "v2", run }), null);
  assert.equal(milestoneDescriptionOf({ repo: "r/r", title: "absent", run }), null);
  assert.throws(() => milestoneDescriptionOf({ repo: "r/r", title: "v1", run: () => "not json" }));
});

test("when a blocker edge was added: the newest `blocked_by_added` of the holder's timeline that names the blocker (slurped pages flattened); none is `null`", () => {
  const { seen, run } = recording(JSON.stringify([[{ event: "labeled" }, { event: "blocked_by_added", blocked_by: { number: 5 }, created_at: "2026-10-01T00:00:00Z" }], [{ event: "blocked_by_added", blocked_by: { number: 5 }, created_at: "2026-10-09T00:00:00Z" },
    { event: "blocked_by_added", blocked_by: { number: 6 }, created_at: "2026-10-10T00:00:00Z" }]]));
  assert.equal(blockedByAddedAtOf({ repo: "a11ign/a11ign", holder: 4, blocker: 5, run }), "2026-10-09T00:00:00Z");
  assert.deepEqual(seen, [["api", "repos/a11ign/a11ign/issues/4/timeline", "--paginate", "--slurp"]]);
  assert.equal(blockedByAddedAtOf({ repo: "r/r", holder: 4, blocker: 99, run }), null);
  assert.throws(() => blockedByAddedAtOf({ repo: "r/r", holder: 4, blocker: 5, run: refusing }), /HTTP 502/);
});

test("a row's timeline for the stock count is every page projected to the event, its time and its label, one object per line; a line that is not JSON throws", () => {
  const { seen, run } = recording('{"event":"labeled","created_at":"2026-10-01T00:00:00Z","label":{"name":"backlog"}}\n\n{"event":"commented","created_at":"2026-10-02T00:00:00Z","label":null}\n');
  assert.deepEqual(stockTimelineEventsOf({ repo: "a11ign/a11ign", number: 7, run }), [{ event: "labeled", created_at: "2026-10-01T00:00:00Z", label: { name: "backlog" } }, { event: "commented", created_at: "2026-10-02T00:00:00Z", label: null }]);
  assert.deepEqual(seen, [["api", "repos/a11ign/a11ign/issues/7/timeline", "--paginate", "--jq", ".[] | {event, created_at, label: (.label // null)}"]]);
  assert.deepEqual(stockTimelineEventsOf({ repo: "r/r", number: 1, run: () => "" }), [], "a read that worked and found no event is the empty history");
  assert.throws(() => stockTimelineEventsOf({ repo: "r/r", number: 1, run: () => "not json\n" }));
  assert.throws(() => stockTimelineEventsOf({ repo: "r/r", number: 1, run: refusing }), /HTTP 502/);
});

test("a row's labels and state are `gh issue view` of the row in its repository, the labels as names and the state in GitHub's word", () => {
  const { seen, run } = recording(JSON.stringify({ labels: [{ name: "parked" }, { name: "lane:any" }], state: "OPEN" }));
  assert.deepEqual(rowLabelsAndStateOf({ repo: "a11ign/agent-org", number: 904, run }), { labels: ["parked", "lane:any"], state: "OPEN" });
  assert.deepEqual(seen, [["issue", "view", "904", "--repo", "a11ign/agent-org", "--json", "labels,state"]]);
  assert.deepEqual(rowLabelsAndStateOf({ repo: "r/r", number: 1, run: () => JSON.stringify({ state: "CLOSED" }) }), { labels: [], state: "CLOSED" });
  assert.throws(() => rowLabelsAndStateOf({ repo: "r/r", number: 1, run: refusing }), /HTTP 502/);
});

test("the merged pull requests that name a row are its `closedByPullRequestsReferences`, the merged ones only; an answer with no list throws (an empty answer read off a refusal would say nothing merged)", () => {
  const nodes = [{ number: 9, state: "MERGED", mergedAt: "2026-10-01T00:00:00Z" }, { number: 10, state: "OPEN", mergedAt: null }, { number: 11, state: "CLOSED", mergedAt: null }, { number: 12, state: "MERGED", mergedAt: null }];
  const { seen, run } = recording(JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes } } } } }));
  assert.deepEqual(mergedClosersOf({ repo: "a11ign/a11ign", number: 5, run }), [{ number: 9, mergedAt: "2026-10-01T00:00:00Z" }]);
  assert.deepEqual(seen, [["api", "graphql", "-f", 'query={ repository(owner: "a11ign", name: "a11ign") { issue(number: 5) { closedByPullRequestsReferences(first: 20) { nodes { number state mergedAt } } } } }']]);
  assert.deepEqual(mergedClosersOf({ repo: "o/n", number: 5, run: () => JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } } }) }), [], "none is a reading when the shape is right");
  assert.throws(() => mergedClosersOf({ repo: "o/n", number: 5, run: () => "{}" }), /#5 could not be read/);
  assert.throws(() => mergedClosersOf({ repo: "o/n", number: 5, run: refusing }), /HTTP 502/);
});

test("when a row closed is its issue record's `closed_at` as epoch milliseconds; a value that is not a time is `null`; a refusal throws", () => {
  const { seen, run } = recording("2026-10-01T00:00:00Z\n");
  assert.equal(closedAtOf({ repo: "a11ign/a11ign", number: 5, run }), Date.parse("2026-10-01T00:00:00Z"));
  assert.deepEqual(seen, [["api", "repos/a11ign/a11ign/issues/5", "--jq", ".closed_at"]]);
  assert.equal(closedAtOf({ repo: "r/r", number: 5, run: () => "null\n" }), null);
  assert.throws(() => closedAtOf({ repo: "r/r", number: 5, run: refusing }), /HTTP 502/);
});

test("the tick's heartbeat variable is a PATCH of the repository variable with one form field; a refusal throws (its standing comment is `editComment`'s: approved-unqueued-reads.test.ts)", () => {
  const variable = recording("");
  writeHeartbeatVariable({ repo: "a11ign/a11ign", variable: "GATE_LAST_TICK", value: "1700000000000", run: variable.run });
  assert.deepEqual(variable.seen, [["api", "-X", "PATCH", "repos/a11ign/a11ign/actions/variables/GATE_LAST_TICK", "-f", "value=1700000000000"]]);
  assert.throws(() => writeHeartbeatVariable({ repo: "r/r", variable: "V", value: "1", run: refusing }), /HTTP 502/);
});
