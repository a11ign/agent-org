// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160 (step 7): WHAT THE WAKE ASKS OF GITHUB, and how it reads the answer. The wake's decisions are core's and their tests run on the fake code host; each operation here builds the SAME argument list the wake
 * built before the move (the ledger's lines and the tick's call census depend on it), so every case asserts the list as the wake spelled it, the reading of the answer, and what a refusal does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";
import { recording } from "./recording-run.test.support.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const REPO = "a11ign/agent-org";
const refused = () => recording(new Error("HTTP 502")).run;

test("an escalated row's title and comments are read with `issue view --json title,comments`; a missing list of comments is none", () => {
  const read = recording({ title: "Fix the thing", comments: [{ body: "claimed", createdAt: "2026-10-01T00:00:00Z" }] });
  assert.deepEqual(rows().titleAndCommentsOf({ repo: REPO, number: 7, run: read.run }), { title: "Fix the thing", comments: [{ body: "claimed", createdAt: "2026-10-01T00:00:00Z" }] });
  assert.deepEqual(read.asked, [["issue", "view", "7", "--repo", REPO, "--json", "title,comments"]]);
  assert.deepEqual(rows().titleAndCommentsOf({ repo: REPO, number: 7, run: recording({}).run }), { title: "", comments: [] });
  assert.throws(() => rows().titleAndCommentsOf({ repo: REPO, number: 7, run: refused() }), /HTTP 502/);
  assert.throws(() => rows().titleAndCommentsOf({ repo: REPO, number: 7, run: recording("not json").run }), SyntaxError);
});

test("a row's label names are read with `issue view --json labels`; an answer with no list is `null`, and a refusal throws", () => {
  const read = recording({ labels: [{ name: "session:worker-7" }, { name: "ready" }] });
  assert.deepEqual(rows().labelNamesOfRow({ repo: REPO, number: 7, run: read.run }), ["session:worker-7", "ready"]);
  assert.deepEqual(read.asked, [["issue", "view", "7", "--repo", REPO, "--json", "labels"]]);
  assert.equal(rows().labelNamesOfRow({ repo: REPO, number: 7, run: recording({}).run }), null);
  assert.throws(() => rows().labelNamesOfRow({ repo: REPO, number: 7, run: refused() }), /HTTP 502/);
});

test("a row's state is GitHub's word for it, asked of the named repository or of the one `gh` aims at; an answer with no state is the word `undefined`, as it always was", () => {
  const read = recording({ state: "CLOSED" });
  assert.equal(rows().rowStateOf({ number: 7, repo: REPO, run: read.run }), "CLOSED");
  assert.equal(rows().rowStateOf({ number: 8, run: read.run }), "CLOSED");
  assert.deepEqual(read.asked, [["issue", "view", "7", "--repo", REPO, "--json", "state"], ["issue", "view", "8", "--json", "state"]]);
  assert.equal(rows().rowStateOf({ number: 7, run: recording({}).run }), "undefined");
  assert.throws(() => rows().rowStateOf({ number: 7, run: refused() }), /HTTP 502/);
});

test("a row's labels, body and title are read in one `issue view`; a body or title that is missing is empty and a missing list of labels throws", () => {
  const read = recording({ labels: [{ name: "tier:haiku" }], body: "the body", title: "T" });
  assert.deepEqual(rows().labelsBodyTitleOf({ repo: REPO, number: 7, run: read.run }), { labels: ["tier:haiku"], body: "the body", title: "T" });
  assert.deepEqual(read.asked, [["issue", "view", "7", "--repo", REPO, "--json", "labels,body,title"]]);
  assert.deepEqual(rows().labelsBodyTitleOf({ repo: REPO, number: 7, run: recording({ labels: [] }).run }), { labels: [], body: "", title: "" });
  assert.throws(() => rows().labelsBodyTitleOf({ repo: REPO, number: 7, run: recording({}).run }), TypeError);
  assert.throws(() => rows().labelsBodyTitleOf({ repo: REPO, number: 7, run: refused() }), /HTTP 502/);
});

test("a filed row carries every label, after the title and the body, and answers what `gh` printed; a refused file throws", () => {
  const read = recording("https://github.com/a11ign/agent-org/issues/9\n");
  assert.equal(rows().fileRowWithLabels({ title: "T", body: "B", labels: ["answer:ceo", "parked", "out-of-release"], run: read.run }), "https://github.com/a11ign/agent-org/issues/9\n");
  assert.deepEqual(read.asked, [["issue", "create", "--title", "T", "--body", "B", "--label", "answer:ceo", "--label", "parked", "--label", "out-of-release"]]);
  assert.throws(() => rows().fileRowWithLabels({ title: "T", body: "B", labels: ["x"], run: refused() }), /HTTP 502/);
});

test("a row is closed with its comment in the repository `gh` aims at; a refused close throws, so no caller reads the row as closed", () => {
  const read = recording("");
  rows().closeHomeRowWithComment({ number: 9, comment: "answered", run: read.run });
  assert.deepEqual(read.asked, [["issue", "close", "9", "--comment", "answered"]]);
  assert.throws(() => rows().closeHomeRowWithComment({ number: 9, comment: "answered", run: refused() }), /HTTP 502/);
});

test("the last event of a label on a row is the newest line of the events; a label that never had one is `null`", () => {
  const read = recording('["labeled","the-ceo","2026-10-01T00:00:00Z"]\n\n["unlabeled","the-chairman","2026-10-02T00:00:00Z"]\n');
  assert.deepEqual(rows().lastLabelEventOf({ number: 7, label: "answer:ceo", run: read.run }), { event: "unlabeled", at: Date.parse("2026-10-02T00:00:00Z"), by: "the-chairman" });
  assert.deepEqual(read.asked, [["api", "--paginate", "repos/{owner}/{repo}/issues/7/events", "--jq", '.[] | select(.label.name == "answer:ceo") | [.event, .actor.login, .created_at] | @json']]);
  assert.equal(rows().lastLabelEventOf({ number: 7, label: "answer:ceo", run: recording("").run }), null);
  assert.deepEqual(rows().lastLabelEventOf({ number: 7, label: "x", run: recording('["unlabeled",null,"2026-10-02T00:00:00Z"]\n').run }), { event: "unlabeled", at: Date.parse("2026-10-02T00:00:00Z"), by: "null" }, "an actor that is gone is the text `null`");
  assert.throws(() => rows().lastLabelEventOf({ number: 7, label: "x", run: refused() }), /HTTP 502/);
});

test("a row's comments are read with who wrote each and whether it carries the marker, the marker quoted for jq", () => {
  const read = recording('[11,"the-ceo","2026-10-01T00:00:00Z",true]\n\n[12,"someone","2026-10-02T00:00:00Z",false]\n');
  assert.deepEqual(rows().markedCommentsOf({ number: 7, marker: '<!-- hold:"7" -->', run: read.run }), [
    { id: 11, login: "the-ceo", at: Date.parse("2026-10-01T00:00:00Z"), marked: true }, { id: 12, login: "someone", at: Date.parse("2026-10-02T00:00:00Z"), marked: false }]);
  assert.deepEqual(read.asked, [["api", "--paginate", "repos/{owner}/{repo}/issues/7/comments", "--jq", '.[] | [.id, .user.login, .created_at, (.body | contains("<!-- hold:\\"7\\" -->"))] | @json']]);
  assert.throws(() => rows().markedCommentsOf({ number: 7, marker: "m", run: refused() }), /HTTP 502/);
});

test("whether a pull request is queued is one GraphQL read of its merge queue entry, owner and name quoted; only the text `true` is a yes, and a refusal throws", () => {
  const read = recording("true\n");
  assert.equal(rows().isPullQueued({ repo: REPO, number: 12, run: read.run }), true);
  assert.deepEqual(read.asked, [["api", "graphql", "-f", 'query={repository(owner:"a11ign",name:"agent-org"){pullRequest(number:12){mergeQueueEntry{position}}}}', "--jq", ".data.repository.pullRequest.mergeQueueEntry != null"]]);
  assert.equal(rows().isPullQueued({ repo: REPO, number: 12, run: recording("false\n").run }), false);
  assert.throws(() => rows().isPullQueued({ repo: REPO, number: 12, run: refused() }), /HTTP 502/);
});

test("a pull request's state is `open` or `closed` from the REST read, and any other word is `null`", () => {
  const read = recording("open\n");
  assert.equal(rows().pullStateWordOf({ repo: REPO, number: 12, run: read.run }), "open");
  assert.deepEqual(read.asked, [["api", `repos/${REPO}/pulls/12`, "--jq", ".state"]]);
  assert.equal(rows().pullStateWordOf({ repo: REPO, number: 12, run: recording(" closed \n").run }), "closed");
  assert.equal(rows().pullStateWordOf({ repo: REPO, number: 12, run: recording("merged\n").run }), null);
  assert.throws(() => rows().pullStateWordOf({ repo: REPO, number: 12, run: refused() }), /HTTP 502/);
});

test("an issue or pull request is read from the REST issue: open or not and its labels; HTTP 404 is `null` (it does not exist), any other refusal throws", () => {
  const read = recording({ state: "open", labels: ["session:worker-7", "ready"] });
  assert.deepEqual(rows().issueStateAndLabelsOf({ repo: REPO, number: 7, run: read.run }), { open: true, labels: ["session:worker-7", "ready"] });
  assert.deepEqual(read.asked, [["api", `repos/${REPO}/issues/7`, "--jq", "{state, labels: [.labels[].name]}"]]);
  assert.deepEqual(rows().issueStateAndLabelsOf({ repo: REPO, number: 7, run: recording({ state: "closed", labels: [] }).run }), { open: false, labels: [] });
  const notFound = Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Not Found (HTTP 404)" });
  assert.equal(rows().issueStateAndLabelsOf({ repo: REPO, number: 99999, run: recording(notFound).run }), null);
  assert.equal(rows().issueStateAndLabelsOf({ repo: REPO, number: 99999, run: recording(new Error("HTTP 404: Not Found")).run }), null);
  assert.throws(() => rows().issueStateAndLabelsOf({ repo: REPO, number: 7, run: refused() }), /HTTP 502/);
  assert.throws(() => rows().issueStateAndLabelsOf({ repo: REPO, number: 7, run: recording("not json").run }), SyntaxError);
});

test("the first comment that starts with a prefix gives its time, over every page; none is `null`", () => {
  const read = recording("2026-10-01T00:00:00Z\n2026-10-02T00:00:00Z\n");
  assert.equal(rows().firstCommentTimeStartingWith({ repo: REPO, number: 7, prefix: "<!-- claim:", pageSize: 100, run: read.run }), "2026-10-01T00:00:00Z");
  assert.deepEqual(read.asked, [["api", "--paginate", `repos/${REPO}/issues/7/comments?per_page=100`, "--jq", '.[] | select(.body | startswith("<!-- claim:")) | .created_at']]);
  assert.equal(rows().firstCommentTimeStartingWith({ repo: REPO, number: 7, prefix: "p", pageSize: 100, run: recording("").run }), null);
  assert.throws(() => rows().firstCommentTimeStartingWith({ repo: REPO, number: 7, prefix: "p", pageSize: 100, run: refused() }), /HTTP 502/);
});

test("a REST read is `gh api` with the arguments given, its answer parsed; an answer that is not JSON and a refusal throw", () => {
  const read = recording([{ number: 1 }]);
  assert.deepEqual(rows().readRestJson({ args: ["repos/a/b/pulls", "-X", "GET"], run: read.run }), [{ number: 1 }]);
  assert.deepEqual(read.asked, [["api", "repos/a/b/pulls", "-X", "GET"]]);
  assert.throws(() => rows().readRestJson({ args: ["x"], run: recording("not json").run }), SyntaxError);
  assert.throws(() => rows().readRestJson({ args: ["x"], run: refused() }), /HTTP 502/);
});

test("the runner with a bound is the plugin's own `gh` cut at the bound named; rows built with none refuse it by name", () => {
  const bounds: number[] = [];
  const within = (timeoutMs: number): RowsRun => { bounds.push(timeoutMs); return () => "ran"; };
  const withRunner = createRows(() => rowsReadHelpers() as unknown as RowsHelpers, { own: () => "", queue: () => "", within });
  assert.equal(withRunner.ownRunWithin(120_000)(["api", "x"]), "ran");
  assert.deepEqual(bounds, [120_000]);
  assert.throws(() => rows().ownRunWithin(120_000), /no runner of their own/);
});
