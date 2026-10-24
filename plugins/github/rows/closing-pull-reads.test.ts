// no-token: none -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 9): THE GRAPHQL READS OF A MERGED PULL REQUEST'S CLOSING REFERENCES AND OF THE ROWS A CLOSE DECLARES, which core's tests of `close-rows-for-merged-pr.ts` and `close-rows-sweep.ts` used to feed with
 * stubbed answers and which are the plugin's now (core's tests run on the fake code host's rows). The argument lists are copied from the callers they were moved from (the query text is written out here, piece by piece
 * as those callers wrote it, so a changed query fails); the answers are GitHub's own shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRowOf, closingRowsOfMergedPull, declaredBuildRowOf, declaredRowOf, mergedPullClosingOf } from "./closing-pull-reads.ts";

/** A `run` that records the argument list it was given and answers `answer`. */
const recording = (answer: unknown) => {
  const seen: string[][] = [];
  return { seen, run: (args: string[]): string => { seen.push(args); return JSON.stringify(answer); } };
};
const refused = (): string => { throw new Error("HTTP 502"); };

const REOPENED = "timelineItems(itemTypes:[REOPENED_EVENT],last:1){nodes{... on ReopenedEvent{createdAt}}}";
const node = (over: Record<string, unknown> = {}) => ({ number: 560, state: "OPEN", labels: { nodes: [{ name: "in-progress" }, { name: "session:x" }] }, timelineItems: { nodes: [{ createdAt: "2026-10-10T20:00:00Z" }] }, ...over });

test("the merge facts of a pull request: ONE lookup of the merge, base, time, branch, body, merge commit and the closing references, each with its repository, labels and last reopening", () => {
  const { seen, run } = recording({ merged: true, baseRefName: "main", mergedAt: "2026-10-10T19:30:00Z", headRefName: "agent/x-560", body: "Closes: none", mergeCommit: { oid: "6d2e9c1" },
    closingIssuesReferences: { nodes: [node({ repository: { nameWithOwner: "a11ign/agent-org" } }), node({ number: 561, state: "CLOSED", labels: { nodes: [] }, timelineItems: { nodes: [] } })] } });
  assert.deepEqual(mergedPullClosingOf({ repo: "a11ign/agent-org", number: "716", run }), {
    merged: true, baseRefName: "main", mergedAt: "2026-10-10T19:30:00Z", headRefName: "agent/x-560", body: "Closes: none", mergeSha: "6d2e9c1",
    closing: [{ number: 560, state: "OPEN", labels: ["in-progress", "session:x"], reopenedAt: "2026-10-10T20:00:00Z", repo: "a11ign/agent-org" }, { number: 561, state: "CLOSED", labels: [], reopenedAt: null, repo: null }],
  });
  assert.deepEqual(seen, [["api", "graphql", "-f", 'query={repository(owner:"a11ign",name:"agent-org"){pullRequest(number:716){'
    + "merged baseRefName mergedAt headRefName body mergeCommit{oid} closingIssuesReferences(first:20){nodes{number state repository{nameWithOwner} "
    + `labels(first:20){nodes{name}} ${REOPENED}}}}}}`, "--jq", ".data.repository.pullRequest"]]);
});

test("a pull request that has NOT merged answers no closing references (the caller refuses it on `merged`), and absent fields read as the caller read them: null, and an empty body", () => {
  const unmerged = mergedPullClosingOf({ repo: "o/r", number: "7", run: recording({ merged: false, baseRefName: "main" }).run });
  assert.deepEqual(unmerged, { merged: false, baseRefName: "main", mergedAt: null, headRefName: null, body: "", mergeSha: null, closing: [] });
  const bare = mergedPullClosingOf({ repo: "o/r", number: "7", run: recording({ merged: true, closingIssuesReferences: { nodes: [{ number: 1, state: "OPEN" }] } }).run });
  assert.deepEqual([bare.baseRefName, bare.mergeSha, bare.closing], [null, null, [{ number: 1, state: "OPEN", labels: [], reopenedAt: null, repo: null }]]);
});

test("a pull request GitHub does not know, an answer that is not JSON, and a refused call all THROW: never a pull request that closes nothing", () => {
  assert.throws(() => mergedPullClosingOf({ repo: "o/r", number: "7", run: recording(null).run }), TypeError);
  assert.throws(() => mergedPullClosingOf({ repo: "o/r", number: "7", run: () => "not json" }), SyntaxError);
  assert.throws(() => mergedPullClosingOf({ repo: "o/r", number: "7", run: refused }), /HTTP 502/);
  assert.throws(() => mergedPullClosingOf({ repo: "o/r", number: "7", run: recording({ merged: true }).run }), TypeError, "a merged pull request with no closing references field is unreadable, not empty");
});

test("the sweep's lookup carries each row's build fields too; a row whose title was not returned is a build of null (could not read), never of no reading", () => {
  const { seen, run } = recording({ mergedAt: "2026-10-10T18:00:00Z", headRefName: "agent/x", body: "b", mergeCommit: { oid: "abc1234" }, closingIssuesReferences: { nodes: [
    node({ title: "Row 560", body: "## Done-when\n\n1. x", milestone: { title: "Out of release" }, parent: { number: 500 } }), node({ number: 561 })] } });
  const read = closingRowsOfMergedPull({ repo: "o/r", number: 900, run });
  assert.deepEqual(read.rows[0], { number: 560, state: "OPEN", labels: ["in-progress", "session:x"], reopenedAt: "2026-10-10T20:00:00Z",
    build: { number: 560, title: "Row 560", body: "## Done-when\n\n1. x", labels: ["in-progress", "session:x"], milestone: "Out of release", parent: 500 } });
  assert.equal(read.rows[1].build, null);
  assert.deepEqual([read.mergedAt, read.headRefName, read.body, read.mergeSha], ["2026-10-10T18:00:00Z", "agent/x", "b", "abc1234"]);
  assert.deepEqual(seen, [["api", "graphql", "-f", 'query={repository(owner:"o",name:"r"){pullRequest(number:900){'
    + "mergedAt headRefName body mergeCommit{oid} closingIssuesReferences(first:20){nodes{number state "
    + "title body milestone{title} parent{number} "
    + `labels(first:20){nodes{name}} ${REOPENED}}}}}}`, "--jq", ".data.repository.pullRequest"]]);
  assert.throws(() => closingRowsOfMergedPull({ repo: "o/r", number: 900, run: recording(null).run }), TypeError);
  assert.throws(() => closingRowsOfMergedPull({ repo: "o/r", number: 900, run: refused }), /HTTP 502/);
});

test("a declared row: state, labels and the last reopening; `null` for a number that is no issue there; a refused read throws", () => {
  const { seen, run } = recording(node());
  assert.deepEqual(declaredRowOf({ repo: "a11ign/agent-org", number: 560, run }), { number: 560, state: "OPEN", labels: ["in-progress", "session:x"], reopenedAt: "2026-10-10T20:00:00Z" });
  assert.deepEqual(seen, [["api", "graphql", "-f", 'query={repository(owner:"a11ign",name:"agent-org"){issue(number:560){number state '
    + `labels(first:20){nodes{name}} ${REOPENED}}}}`, "--jq", ".data.repository.issue"]]);
  assert.equal(declaredRowOf({ repo: "o/r", number: 9, run: recording(null).run }), null, "a pull request's number or a typo is no issue");
  assert.throws(() => declaredRowOf({ repo: "o/r", number: 9, run: refused }), /HTTP 502/);
  assert.throws(() => declaredRowOf({ repo: "o/r", number: 9, run: () => "not json" }), SyntaxError);
});

test("the sweep's declared row also carries its build; one whose title was not returned is a build of null", () => {
  const { seen, run } = recording(node({ title: "Row 560", body: null, milestone: null, parent: null }));
  assert.deepEqual(declaredBuildRowOf({ repo: "a11ign/agent-org", number: 560, run }), {
    row: { number: 560, state: "OPEN", labels: ["in-progress", "session:x"], reopenedAt: "2026-10-10T20:00:00Z" },
    build: { number: 560, title: "Row 560", body: "", labels: ["in-progress", "session:x"], milestone: null, parent: null },
  });
  assert.deepEqual(seen, [["api", "graphql", "-f", 'query={repository(owner:"a11ign",name:"agent-org"){issue(number:560){number state title body milestone{title} parent{number} '
    + `labels(first:20){nodes{name}} ${REOPENED}}}}`, "--jq", ".data.repository.issue"]]);
  assert.equal(declaredBuildRowOf({ repo: "o/r", number: 560, run: recording(node()).run })?.build, null);
  assert.equal(declaredBuildRowOf({ repo: "o/r", number: 9, run: recording(null).run }), null);
  assert.throws(() => declaredBuildRowOf({ repo: "o/r", number: 9, run: refused }), /HTTP 502/);
});

test("a closed row as a build row: title, body, up to 30 labels, milestone and parent; `null` for no such issue; a refused read throws", () => {
  const { seen, run } = recording({ number: 560, title: "T", body: "B", labels: { nodes: [{ name: "x" }] }, milestone: { title: "M" }, parent: { number: 500 } });
  assert.deepEqual(buildRowOf({ repo: "a11ign/agent-org", number: 560, run }), { number: 560, title: "T", body: "B", labels: ["x"], milestone: "M", parent: 500 });
  assert.deepEqual(seen, [["api", "graphql", "-f", 'query={repository(owner:"a11ign",name:"agent-org"){issue(number:560){number title body labels(first:30){nodes{name}} milestone{title} parent{number}}}}', "--jq", ".data.repository.issue"]]);
  assert.deepEqual(buildRowOf({ repo: "o/r", number: 1, run: recording({ number: 1, title: "T", body: null }).run }), { number: 1, title: "T", body: "", labels: [], milestone: null, parent: null });
  assert.equal(buildRowOf({ repo: "o/r", number: 1, run: recording(null).run }), null);
  assert.throws(() => buildRowOf({ repo: "o/r", number: 1, run: refused }), /HTTP 502/);
});
