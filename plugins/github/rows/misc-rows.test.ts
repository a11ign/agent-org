// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 7): THE ARGUMENTS AND READINGS OF THE OPERATIONS THE CLAIM'S CLOCK, THE PROVENANCE AUDIT, THE REACHABILITY CHECK, THE DUPLICATE-ROW CHECK AND THE LABEL STRIP ASK, which core's tests of those callers used to assert
 * over a stubbed `gh` and which are the plugin's now (core's tests run on the fake code host's rows). The argument lists are copied from the callers they were moved from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closedRowListingTextOf, closingTimelineTextOf, labelEventLogTextOf, labelEventsOf, miscRowsOf, openRestListingOf, pullStatesOf, pullStatesOfBranchIn, removeLabelsFromRow, rowBodyIn, rowFactsIn } from "./misc-rows.ts";

/** A `run` that records the argument list it was given and answers `answer`. */
const recording = (answer: string) => {
  const seen: string[][] = [];
  return { seen, run: (args: string[]): string => { seen.push(args); return answer; } };
};

const labelled = (label: string, at: string) => JSON.stringify({ event: "labeled", label, at });

test("a row's label events: one paginated REST call projected to three fields, one event per line, and a line that is not JSON is thrown (never an empty history)", () => {
  const { seen, run } = recording(`${labelled("session:a", "2026-10-09T21:29:49Z")}\n\n${labelled("ready", "2026-10-09T22:00:00Z")}\n`);
  assert.deepEqual(labelEventsOf({ repo: "a11ign/a11ign", row: 4524, run }).map((e) => e.label), ["session:a", "ready"]);
  assert.deepEqual(seen, [["api", "--paginate", "repos/a11ign/a11ign/issues/4524/events", "--jq",
    '.[] | select(.event == "labeled" or .event == "unlabeled") | {event: .event, label: .label.name, at: .created_at}']]);
  assert.deepEqual(labelEventsOf({ repo: "r/r", row: 1, run: () => "" }), [], "a read that worked and found no event is the empty history");
  assert.throws(() => labelEventsOf({ repo: "r/r", row: 1, run: () => "not json\n" }));
  assert.throws(() => labelEventsOf({ repo: "r/r", row: 1, run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
});

test("taking labels off a row is ONE edit of the row in its repository, one flag per label, and a refusal throws", () => {
  const { seen, run } = recording("");
  removeLabelsFromRow({ repo: "a11ign/a11ign", number: 7, labels: ["ready", "session:x"], run });
  assert.deepEqual(seen, [["issue", "edit", "7", "--repo", "a11ign/a11ign", "--remove-label", "ready", "--remove-label", "session:x"]]);
  assert.throws(() => removeLabelsFromRow({ repo: "r/r", number: 1, labels: ["ready"], run: () => { throw new Error("HTTP 403"); } }), /HTTP 403/);
});

test("the closing event of a row is read with one GraphQL query of the owner and name, the last 30 closed events and the pull request behind each", () => {
  const { seen, run } = recording("{}");
  assert.equal(closingTimelineTextOf({ repo: "a11ign/a11ign", number: 887, run }), "{}");
  assert.deepEqual(seen, [["api", "graphql", "-f", 'query=query{repository(owner:"a11ign",name:"a11ign"){issue(number:887){'
    + "timelineItems(last:30,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{"
    + "... on PullRequest{number headRefName merged createdAt labels(first:50){nodes{name}}}}}}}}}}"]]);
});

test("#848: the closed listing ASKS for stateReason, in the repository and at the limit it is given", () => {
  const { seen, run } = recording("[]");
  closedRowListingTextOf({ repo: "a11ign/a11ign", limit: 1000, run });
  assert.deepEqual(seen, [["issue", "list", "--repo", "a11ign/a11ign", "--state", "closed", "--limit", "1000", "--json", "number,title,closedAt,stateReason"]]);
  assert.match(seen[0][seen[0].indexOf("--json") + 1], /\bstateReason\b/, "or a NOT_PLANNED row can never be seen");
});

test("the repository's event log is every page of the label events, projected to one object per line", () => {
  const { seen, run } = recording("");
  labelEventLogTextOf({ repo: "a11ign/a11ign", run });
  assert.deepEqual(seen, [["api", "--paginate", "repos/a11ign/a11ign/issues/events?per_page=100", "--jq",
    '.[] | select(.event == "labeled" or .event == "unlabeled") | { number: .issue.number, event: .event, label: .label.name, at: .created_at }']]);
});

test("the pull requests of a repository: the newest `limit` in any state with their branches; the pull requests of one branch; a branch's answer that is not a list is none", () => {
  const all = recording(JSON.stringify([{ number: 3, state: "OPEN", headRefName: "a" }]));
  assert.deepEqual(pullStatesOf({ repo: "a11ign/a11ign", limit: 400, run: all.run }), [{ number: 3, state: "OPEN", headRefName: "a" }]);
  assert.deepEqual(all.seen, [["pr", "list", "--repo", "a11ign/a11ign", "--state", "all", "--limit", "400", "--json", "number,state,headRefName"]]);
  const one = recording(JSON.stringify([{ number: 3, state: "MERGED" }]));
  assert.deepEqual(pullStatesOfBranchIn({ repo: "a11ign/a11ign", branch: "agent/x", run: one.run }), [{ number: 3, state: "MERGED" }]);
  assert.deepEqual(one.seen, [["pr", "list", "--repo", "a11ign/a11ign", "--head", "agent/x", "--state", "all", "--json", "number,state"]]);
  assert.deepEqual(pullStatesOfBranchIn({ repo: "r/r", branch: "b", run: () => "{}" }), []);
  assert.throws(() => pullStatesOf({ repo: "r/r", limit: 1, run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
  assert.throws(() => pullStatesOfBranchIn({ repo: "r/r", branch: "b", run: () => "nope" }));
});

test("a row's facts and body are read in its repository; a body with none is the empty text", () => {
  const facts = recording(JSON.stringify({ body: "b", labels: [{ name: "ready" }], state: "OPEN", closedAt: null }));
  assert.deepEqual(rowFactsIn({ repo: "a11ign/a11ign", number: 77, run: facts.run }).labels, [{ name: "ready" }]);
  assert.deepEqual(facts.seen, [["issue", "view", "77", "--repo", "a11ign/a11ign", "--json", "body,labels,state,closedAt"]]);
  const body = recording(JSON.stringify({ body: "## Region\n" }));
  assert.equal(rowBodyIn({ repo: "a11ign/a11ign", number: 9, run: body.run }), "## Region\n");
  assert.deepEqual(body.seen, [["issue", "view", "9", "--repo", "a11ign/a11ign", "--json", "body"]]);
  assert.equal(rowBodyIn({ repo: "r/r", number: 9, run: () => JSON.stringify({ body: null }) }), "");
  assert.throws(() => rowBodyIn({ repo: "r/r", number: 9, run: () => "nope" }));
});

test("agent-org#1005: the open rows are paged over REST (the core pool), pull requests are dropped from the issues, a short page is the last, and a listing that never ends is thrown", () => {
  const pages: string[][] = [];
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
  const run = (args: string[]): string => {
    pages.push(args);
    return JSON.stringify(args[1].endsWith("page=1") ? [...full.slice(0, 99), { number: 500, pull_request: {} }] : [{ number: 101 }]);
  };
  const rows = openRestListingOf({ repo: "a11ign/a11ign", kind: "issues", run });
  assert.deepEqual(pages, [["api", "repos/a11ign/a11ign/issues?state=open&per_page=100&page=1"], ["api", "repos/a11ign/a11ign/issues?state=open&per_page=100&page=2"]]);
  assert.equal(rows.length, 100, "99 issues of the first page and the one of the second, and the pull request dropped");
  assert.equal(openRestListingOf({ repo: "r/r", kind: "pulls", run: () => JSON.stringify([{ number: 1, pull_request: {} }]) }).length, 1, "a pull request listing keeps what it lists");
  assert.throws(() => openRestListingOf({ repo: "r/r", kind: "issues", run: () => "{}" }), /did not come back as a list/);
  assert.throws(() => openRestListingOf({ repo: "r/r", kind: "issues", run: () => JSON.stringify(full) }), /run past 100 pages/);
});

test("a caller that hands no `run` has the plugin's own `gh` run the call, and one that hands a `run` has its own used", () => {
  const own = recording(JSON.stringify({ body: "own" }));
  const rows = miscRowsOf(own.run);
  assert.equal(rows.rowBodyIn({ repo: "r/r", number: 1 }), "own");
  const theirs = recording(JSON.stringify({ body: "theirs" }));
  assert.equal(rows.rowBodyIn({ repo: "r/r", number: 1, run: theirs.run }), "theirs");
  assert.equal(own.seen.length, 1);
  assert.equal(theirs.seen.length, 1);
});
