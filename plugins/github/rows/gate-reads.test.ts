// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160 (step 6): WHAT THE WORK GATE ASKS OF GITHUB, and how it reads the answer. The gate's decisions are core's and their tests run on the fake code host; each operation here builds the SAME argument list the gate
 * built before the move (the tick's memo keys and the ledger's lines depend on it), so every case asserts the argument list as the gate spelled it, and the reading of the answer the gate did.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";
import { forgetRefusedReads } from "./rows-by-label.ts";
import { recording } from "./recording-run.test.support.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const REPO = "a11ign/agent-org";

test("a row's events are read from `issues/{n}/events`, the unlabeled ones with the label named and when", () => {
  const read = recording('{"name":"blocked","at":"2026-10-01T00:00:00Z"}\n\n{"name":"parked","at":"2026-10-02T00:00:00Z"}\n');
  assert.deepEqual(rows().unlabeledEventsOf({ repo: REPO, number: 7, run: read.run }), [{ name: "blocked", at: "2026-10-01T00:00:00Z" }, { name: "parked", at: "2026-10-02T00:00:00Z" }]);
  assert.deepEqual(read.asked, [["api", `repos/${REPO}/issues/7/events`, "--paginate", "--jq", '.[] | select(.event == "unlabeled") | {name: .label.name, at: .created_at}']]);
  assert.throws(() => rows().unlabeledEventsOf({ repo: REPO, number: 7, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});

test("when a label was applied: the times in the order GitHub lists them, the repository `gh` aims at when none is named", () => {
  const read = recording("2026-10-01T00:00:00Z\n\n 2026-10-03T00:00:00Z \n");
  assert.deepEqual(rows().labeledEventTimesOf({ number: 7, label: "needs:chairman", run: read.run }), ["2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z"]);
  assert.deepEqual(rows().labeledEventTimesOf({ repo: REPO, number: 8, label: "awaiting-evidence", run: read.run }), ["2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z"]);
  assert.deepEqual(read.asked, [
    ["api", "repos/{owner}/{repo}/issues/7/events", "--paginate", "--jq", '.[] | select(.event == "labeled" and .label.name == "needs:chairman") | .created_at'],
    ["api", `repos/${REPO}/issues/8/events`, "--paginate", "--jq", '.[] | select(.event == "labeled" and .label.name == "awaiting-evidence") | .created_at'],
  ]);
});

test("who applied a label last: the newest line, and `null` for an event whose actor is gone (jq prints `null`), never an older labeller's", () => {
  const asked = (answer: string) => rows().newestLabellerOf({ number: 7, label: "priority:chairman", run: recording(answer).run });
  assert.equal(asked("someone\nthe-chairman\n"), "the-chairman");
  assert.equal(asked("the-chairman\nnull\n"), null);
  assert.equal(asked(""), null);
  const read = recording("x\n");
  rows().newestLabellerOf({ number: 7, label: "priority:chairman", run: read.run });
  assert.deepEqual(read.asked, [["api", "repos/{owner}/{repo}/issues/7/events", "--paginate", "--jq", '.[] | select(.event == "labeled" and .label.name == "priority:chairman") | .actor.login']]);
});

test("a row's comments are read as author, time and the first 200 characters, one JSON object a line", () => {
  const read = recording('{"author":"the-chairman","at":"2026-10-04T10:17:05Z","body":"ok"}\n');
  assert.deepEqual(rows().commentActivityOf({ number: 7, run: read.run }), [{ author: "the-chairman", at: "2026-10-04T10:17:05Z", body: "ok" }]);
  assert.deepEqual(read.asked, [["api", "repos/{owner}/{repo}/issues/7/comments", "--paginate", "--jq", ".[] | {author: (.user.login // \"\"), at: .created_at, body: ((.body // \"\") | .[0:200])}"]]);
});

test("a row's timeline is projected to its labeled, unlabeled and commented events", () => {
  const read = recording('{"event":"labeled","label":{"name":"answer:ceo"},"actor":"a","id":1,"created_at":"2026-10-01T00:00:00Z"}\n');
  assert.deepEqual(rows().rowTimelineOf({ repo: REPO, number: 7, run: read.run }), [{ event: "labeled", label: { name: "answer:ceo" }, actor: "a", id: 1, created_at: "2026-10-01T00:00:00Z" }]);
  assert.deepEqual(read.asked, [["api", `repos/${REPO}/issues/7/timeline`, "--paginate", "--jq",
    '.[] | select(.event == "labeled" or .event == "unlabeled" or .event == "commented") | {event: .event, label: {name: .label.name}, actor: .actor.login, id: .id, created_at: .created_at}']]);
});

test("the state of an item a wait names is one `issues/{n}` read with the fields a wait reads; an incident item is read for its state, body and labels, by `#n` or `owner/repo#n`", () => {
  const wait = recording({ state: "closed", closed_at: "t", updated_at: "u", merged_at: null, labels: ["a"] });
  assert.deepEqual(rows().waitRefOf({ repo: REPO, number: 7, run: wait.run }), { state: "closed", closed_at: "t", updated_at: "u", merged_at: null, labels: ["a"] });
  assert.deepEqual(wait.asked, [["api", `repos/${REPO}/issues/7`, "--jq", "{state, closed_at, updated_at, merged_at: .pull_request.merged_at, labels: [.labels[].name]}"]]);

  const item = recording({ state: "open", body: "Incident: incident:x", labels: ["incident", 5] });
  assert.deepEqual(rows().incidentItemOf({ ref: "#889", run: item.run }), { open: true, labels: ["incident", "5"], body: "Incident: incident:x" });
  assert.deepEqual(rows().incidentItemOf({ ref: "o/r#2", run: recording({ state: "closed" }).run }), { open: false, labels: [], body: "" });
  rows().incidentItemOf({ ref: "o/r#2", run: item.run });
  assert.deepEqual(item.asked, [
    ["api", "repos/{owner}/{repo}/issues/889", "--jq", "{state, body, labels: [.labels[].name]}"],
    ["api", "repos/o/r/issues/2", "--jq", "{state, body, labels: [.labels[].name]}"],
  ]);
  const body = recording({ body: "the body" });
  assert.equal(rows().rowBodyOf({ number: 9, run: body.run }), "the body");
  assert.deepEqual(body.asked, [["api", "repos/{owner}/{repo}/issues/9", "--jq", "{body}"]]);
});

test("a row's state and newest comment: none when it has no comment, the page of the last one otherwise, and null for a row that cannot be read whole", () => {
  const answers = (state: unknown, comments: unknown, page: unknown) => recording((args: string[]) => (args[1].endsWith("/issues/7") ? { state, comments } : page));
  const one = answers("open", 0, null);
  assert.deepEqual(rows().rowStateAndNewestComment({ repo: REPO, number: 7, run: one.run }), { state: "open", lastComment: null });
  assert.deepEqual(one.asked, [["api", `repos/${REPO}/issues/7`, "--jq", "{state: .state, comments: .comments}"]]);
  const three = answers("closed", 3, { body: "last", createdAt: "t" });
  assert.deepEqual(rows().rowStateAndNewestComment({ repo: REPO, number: 7, run: three.run }), { state: "closed", lastComment: { body: "last", createdAt: "t" } });
  assert.deepEqual(three.asked[1], ["api", `repos/${REPO}/issues/7/comments?per_page=1&page=3`, "--jq", ".[0] | {body: .body, createdAt: .created_at}"]);
  for (const bad of [answers(7, 1, {}), answers("open", "1", {}), answers("open", 2, { body: 4 })]) assert.equal(rows().rowStateAndNewestComment({ repo: REPO, number: 7, run: bad.run }), null);
  assert.equal(rows().rowStateAndNewestComment({ repo: REPO, number: 7, run: recording(new Error("HTTP 502")).run }), null);
});

test("a promotion reads one row with `issue view`, its labels as names and its blocked-by edges as they come", () => {
  const read = recording({ labels: [{ name: "backlog" }], state: "OPEN", body: null, blockedBy: { nodes: [{ number: 3, state: "CLOSED" }] } });
  assert.deepEqual(rows().rowForPromotion({ repo: REPO, number: 7, run: read.run }), { labels: ["backlog"], state: "OPEN", body: "", blockedBy: { nodes: [{ number: 3, state: "CLOSED" }] } });
  assert.deepEqual(read.asked, [["issue", "view", "7", "--repo", REPO, "--json", "labels,state,body,blockedBy"]]);
  assert.deepEqual(rows().rowForPromotion({ repo: REPO, number: 7, run: recording({ state: "OPEN" }).run }), { labels: [], state: "OPEN", body: "", blockedBy: {} });
});

test("the milestone clock's pages: the tracker's issue events and its closed pull requests, a page at a time", () => {
  const events = recording([{ at: "t" }]);
  assert.deepEqual(rows().issueEventsPage({ repo: REPO, page: 2, pageSize: 100, run: events.run }), [{ at: "t" }]);
  assert.deepEqual(events.asked, [["api", `repos/${REPO}/issues/events?per_page=100&page=2`, "--jq",
    "[.[] | {at: .created_at, event: .event, label: (.label.name // \"\"), milestone: (.issue.milestone.number // 0), pr: (.issue.pull_request != null)}]"]]);
  const pulls = recording([]);
  rows().closedPullsPage({ repo: "o/r", page: 3, pageSize: 100, run: pulls.run });
  assert.deepEqual(pulls.asked, [["api", "repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=3", "--jq", "[.[] | {at: .updated_at, closedAt: .closed_at, body: (.body // \"\")}]"]]);
  assert.throws(() => rows().issueEventsPage({ repo: REPO, page: 1, pageSize: 100, run: recording("<html>").run }));
});

test("whether a tag exists compares the exact ref (the listing matches by prefix), and is null for a read that failed or an answer that is not a list", () => {
  const listing = (refs: unknown) => recording(refs);
  assert.equal(rows().tagExistsOn({ repo: REPO, tag: "v1.2", run: listing([{ ref: "refs/tags/v1.2.3" }]).run }), false, "a prefix is not the tag");
  assert.equal(rows().tagExistsOn({ repo: REPO, tag: "v1.2", run: listing([{ ref: "refs/tags/v1.2" }, { ref: "refs/tags/v1.2.3" }]).run }), true);
  assert.equal(rows().tagExistsOn({ repo: REPO, tag: "v1.2", run: listing([]).run }), false);
  assert.equal(rows().tagExistsOn({ repo: REPO, tag: "v1.2", run: listing({ message: "Not Found" }).run }), null);
  assert.equal(rows().tagExistsOn({ repo: REPO, tag: "v1.2", run: recording(new Error("HTTP 502")).run }), null);
  const read = listing([]);
  rows().tagExistsOn({ repo: REPO, tag: "v1.2", run: read.run });
  assert.deepEqual(read.asked, [["api", `repos/${REPO}/git/matching-refs/tags/v1.2`]]);
});

test("the newest comments of several rows are ONE aliased GraphQL read, and null when it is refused, carries `errors` beside `data`, or leaves a row out", () => {
  const nodes = [{ id: 1, body: "b", createdAt: "t", author: { login: "x" } }];
  const read = recording({ data: { repository: { r4: { number: 4, comments: { nodes } }, r5: { number: 5, comments: {} } } } });
  const got = rows().newestCommentsOf({ repo: REPO, numbers: [4, 5], last: 20, run: read.run });
  assert.deepEqual([...got!], [[4, nodes]], "a row whose comments the answer does not carry is left out, never filled with []");
  assert.deepEqual(read.asked, [["api", "graphql", "-f", "query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { r4: issue(number: 4) { number comments(last: 20) { nodes { id body createdAt author { login } } } } r5: issue(number: 5) { number comments(last: 20) { nodes { id body createdAt author { login } } } } } }",
    "-F", "owner=a11ign", "-F", "name=agent-org"]]);
  assert.equal(rows().newestCommentsOf({ repo: REPO, numbers: [4], last: 20, run: recording({ errors: [{}], data: { repository: {} } }).run }), null);
  assert.equal(rows().newestCommentsOf({ repo: REPO, numbers: [4], last: 20, run: recording(new Error("HTTP 502")).run }), null);
});

test("the recently closed rows are one GraphQL read of the most recently UPDATED, under the tick's refusal memory", () => {
  forgetRefusedReads();
  const read = recording({ data: { repository: { issues: { nodes: [{ number: 4, closedAt: "t", updatedAt: "u" }] } } } });
  assert.deepEqual(rows().recentlyClosedRowsOf({ limit: 100, run: read.run }), [{ number: 4, closedAt: "t", updatedAt: "u" }]);
  assert.deepEqual(read.asked, [["api", "graphql", "-f",
    "query=query($owner:String!,$name:String!,$first:Int!){repository(owner:$owner,name:$name){issues(states:CLOSED,first:$first,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number closedAt updatedAt}}}}",
    "-F", "owner={owner}", "-F", "name={repo}", "-F", "first=100"]]);
  assert.equal(rows().recentlyClosedRowsOf({ limit: 100, run: recording({ data: {} }).run }), null);
  assert.throws(() => rows().recentlyClosedRowsOf({ limit: 100, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
  forgetRefusedReads();
});

test("the gate's writes are the commands it wrote: a comment (aimed where it says), labels, a body, a label created, a row filed, a pull request readied, a card added and its Status", () => {
  const read = recording("https://github.com/o/r/issues/12\n");
  const run = (args: string[], repo?: string) => read.run(repo === undefined ? args : [...args, `aimed:${repo}`]);
  const host = rows();
  host.commentOnRow({ number: 7, body: "b", run });
  host.commentOnRow({ number: "8", body: "b", aim: "o/r", run });
  host.addLabelToRow({ number: "7", label: "needs:chairman", run });
  host.removeLabelFromRow({ number: 7, label: "priority:emergency", run });
  host.setRowBody({ number: "7", body: "new", run });
  host.ensureLabel({ name: "resolver-defect", description: "d", run });
  assert.equal(host.fileLabelledRow({ title: "t", label: "incident", body: "b", run }), "https://github.com/o/r/issues/12\n");
  host.addLabelToRowByApi({ repo: REPO, number: 7, label: "answer:ceo", run });
  host.markPullReady({ number: 3, run });
  host.markPullReady({ number: 4, repo: "o/r", run });
  host.addRowToProject({ owner: "a11ign", projectNumber: 3, url: "https://github.com/o/r/issues/7", run });
  host.setProjectStatus({ owner: "a11ign", projectNumber: 3, url: "https://github.com/o/r/issues/7", status: "In progress", run });
  assert.deepEqual(read.asked, [
    ["issue", "comment", "7", "--body", "b"], ["issue", "comment", "8", "--body", "b", "aimed:o/r"], ["issue", "edit", "7", "--add-label", "needs:chairman"], ["issue", "edit", "7", "--remove-label", "priority:emergency"],
    ["issue", "edit", "7", "--body", "new"], ["label", "create", "resolver-defect", "--force", "--description", "d"], ["issue", "create", "--title", "t", "--label", "incident", "--body", "b"],
    ["api", `repos/${REPO}/issues/7/labels`, "-f", "labels[]=answer:ceo"], ["pr", "ready", "3"], ["pr", "ready", "4", "--repo", "o/r"],
    ["project", "item-add", "3", "--owner", "a11ign", "--url", "https://github.com/o/r/issues/7"],
    ["project", "item-edit", "3", "--owner", "a11ign", "--url", "https://github.com/o/r/issues/7", "--field", "Status", "--value", "In progress"],
  ]);
  assert.throws(() => host.commentOnRow({ number: 7, body: "b", run: recording(new Error("HTTP 403")).run }), /HTTP 403/);
});

test("the comments already on a row are their bodies; an answer with no list is a row with none, and a refusal throws", () => {
  const read = recording({ comments: [{ body: "one" }, { body: null }] });
  assert.deepEqual(rows().commentBodiesOfRow({ number: 7, run: read.run }), ["one", ""]);
  assert.deepEqual(read.asked, [["issue", "view", "7", "--json", "comments"]]);
  assert.deepEqual(rows().commentBodiesOfRow({ number: 7, run: recording({}).run }), []);
  assert.throws(() => rows().commentBodiesOfRow({ number: 7, run: recording(new Error("HTTP 502")).run }), /HTTP 502/);
});
