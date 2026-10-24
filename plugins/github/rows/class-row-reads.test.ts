// no-token: none -- every operation is handed a stub `run` that records the argument list (or pages); nothing here spawns `gh` or reaches the network
/**
 * A11-160 (step 9): WHAT THE CLASS-REPEAT FACT, THE LOW-CONFIDENCE FILING, THE HAND-FIX LEDGER AND THE NIGHTLY FLEET-GATED FIRING SAY TO `gh`, which core's tests of those callers used to assert over a stubbed `gh` and which
 * are the plugin's now (core's tests run on the fake code host's rows, commits and merged pull requests). The argument lists are copied from the modules they were moved from; the answers are GitHub's own shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { connectionOf, readsRowsByLabel, readsRowsSince, sinceAnswer } from "../../../src/packaging/rows-by-label-fixtures.ts";
import { createRows } from "./index.ts";
import { closedClassRowsOf, closedRowsTitledOf, mainCommitLoginsSince, openRowsCarryingLabel } from "./class-row-reads.ts";
import { recording } from "./recording-run.test.support.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const REPO = "a11ign/a11ign";

/** The closed-row listing's projection, as `gh api --jq` prints it. */
const CLOSED_PROJECTION = "[.[] | {number, state, closed_at, title, pull_request: (.pull_request != null), labels: [.labels[].name]}]";
const TITLED_PROJECTION = "[.[] | {number, state, pull_request: (.pull_request != null), title, labels: [.labels[].name]}]";
const entry = (number: number, over: object = {}) => ({ number, state: "closed", closed_at: "2026-10-08T13:00:00Z", title: `row ${number}`, pull_request: false, labels: ["class:x"], ...over });

// --- class-repeat.ts: the closed rows that carry a class label ---------------------------------------------------------------------------------

test("the newest-updated closed rows are ONE REST call of the issues endpoint at the page it is given, projected to the fields the fact reads; a class narrows it by its label", () => {
  const all = recording([entry(11)]);
  closedClassRowsOf({ repo: REPO, classLabel: null, perPage: 100, run: all.run });
  assert.deepEqual(all.asked, [["api", "--method", "GET", `repos/${REPO}/issues`, "-f", "state=closed", "-f", "sort=updated", "-f", "direction=desc", "-f", "per_page=100", "--jq", CLOSED_PROJECTION]]);
  const narrowed = recording([entry(11)]);
  closedClassRowsOf({ repo: REPO, classLabel: "class:x", perPage: 100, run: narrowed.run });
  assert.deepEqual(narrowed.asked, [["api", "--method", "GET", `repos/${REPO}/issues`, "-f", "state=closed", "-f", "sort=updated", "-f", "direction=desc", "-f", "per_page=100", "-f", "labels=class:x", "--jq", CLOSED_PROJECTION]]);
});

test("a closed row is a number, a title, the time it closed (epoch ms, null where none is stated) and its label names; an open row, a pull request and a row of another state are not rows of the listing", () => {
  const listed = closedClassRowsOf({ repo: REPO, classLabel: null, perPage: 100, run: () => JSON.stringify([
    entry(11, { labels: ["class:x", "bug"] }), entry(10, { closed_at: null }), entry(9, { closed_at: "not a time" }),
    entry(8, { state: "open", closed_at: null }), entry(7, { pull_request: true }), entry(6, { labels: [] }),
  ]) });
  assert.deepEqual(listed, [
    { number: 11, title: "row 11", closedAt: Date.parse("2026-10-08T13:00:00Z"), labels: ["class:x", "bug"] },
    { number: 10, title: "row 10", closedAt: null, labels: ["class:x"] },
    { number: 9, title: "row 9", closedAt: null, labels: ["class:x"] },
    { number: 6, title: "row 6", closedAt: Date.parse("2026-10-08T13:00:00Z"), labels: [] },
  ]);
});

test("a tracker that hands an open row back anyway does not make it a closed row, and a pull request carrying the label is not an instance", () => {
  const hostile = [entry(11), entry(10, { state: "open", closed_at: null }), entry(9, { pull_request: true })];
  assert.deepEqual(closedClassRowsOf({ repo: REPO, classLabel: "class:x", perPage: 100, run: () => JSON.stringify(hostile) })?.map((row) => row.number), [11]);
});

test("an answer that is not a listing of rows is null, never an empty list: not JSON, not a list, or a list with an entry that is no row", () => {
  for (const text of ["<html>not json</html>", "{}", "null", '[{"state":"closed","labels":[]}]', '[{"number":3,"labels":"class:x"}]']) {
    assert.equal(closedClassRowsOf({ repo: REPO, classLabel: null, perPage: 100, run: () => text }), null, text);
  }
  assert.deepEqual(closedClassRowsOf({ repo: REPO, classLabel: null, perPage: 100, run: () => "[]" }), [], "control: an empty list that WAS read is the empty list");
  assert.throws(() => closedClassRowsOf({ repo: REPO, classLabel: null, perPage: 100, run: () => { throw new Error("HTTP 403: API rate limit exceeded"); } }), /rate limit/);
});

test("the titled listing is the same call with the fields the labelling reads, keeps only closed rows that are not pull requests, and is null for an answer that is not a list", () => {
  const seen = recording([{ number: 10, state: "closed", pull_request: false, title: "copies drifted", labels: ["defect"] }, { number: 11, state: "open", pull_request: false, title: "t", labels: [] },
    { number: 12, state: "closed", pull_request: true, title: "t", labels: [] }, { number: 13, state: "closed", pull_request: false, title: 4, labels: [] }, { number: 14, state: "closed", pull_request: false, title: "t", labels: "x" }]);
  assert.deepEqual(closedRowsTitledOf({ repo: "o/r", perPage: 100, run: seen.run }), [{ number: 10, title: "copies drifted", labels: ["defect"] }]);
  assert.deepEqual(seen.asked, [["api", "--method", "GET", "repos/o/r/issues", "-f", "state=closed", "-f", "sort=updated", "-f", "direction=desc", "-f", "per_page=100", "--jq", TITLED_PROJECTION]]);
  assert.equal(closedRowsTitledOf({ repo: "o/r", perPage: 100, run: () => "{}" }), null);
  assert.throws(() => closedRowsTitledOf({ repo: "o/r", perPage: 100, run: () => "not json" }), SyntaxError, "a body that is not JSON is a throw here: the labelling logs it and tries again");
  assert.throws(() => closedRowsTitledOf({ repo: "o/r", perPage: 100, run: () => { throw new Error("HTTP 403 rate limited"); } }), /rate limited/);
});

// --- provider-low-confidence.ts: the rows of one class, in either state ---------------------------------------------------------------------------

test("the rows of a label are read as the by-label connection in BOTH states, the open ones first, with number, title, state and close time; a refusal throws", () => {
  const nodes = { OPEN: [{ number: 4800, title: "open one", state: "OPEN", closedAt: null }], CLOSED: [{ number: 4700, title: "closed one", state: "CLOSED", closedAt: "2026-10-09T08:00:00Z" }] };
  const seen = recording((args: string[]) => { const read = readsRowsByLabel(args); return read === null ? new Error("unexpected") : JSON.parse(connectionOf(nodes[read.state])); });
  assert.deepEqual(rows().labelledRowsOf({ repo: REPO, label: "class:provider-low-confidence", run: seen.run }), [
    { number: 4800, title: "open one", state: "OPEN", closedAt: null }, { number: 4700, title: "closed one", state: "CLOSED", closedAt: "2026-10-09T08:00:00Z" },
  ]);
  assert.deepEqual(seen.asked.map((args) => readsRowsByLabel(args)), [{ label: "class:provider-low-confidence", state: "OPEN" }, { label: "class:provider-low-confidence", state: "CLOSED" }]);
  const query = seen.asked[0].find((arg) => arg.startsWith("query=")) ?? "";
  assert.match(query, /number title state closedAt/, "the fields the filing reads, and no search: the connection");
  assert.ok(seen.asked.every((args) => !args.includes("--label") && !args.includes("--search")));
  assert.throws(() => rows().labelledRowsOf({ repo: REPO, label: "x", run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
  assert.throws(() => rows().labelledRowsOf({ repo: REPO, label: "x", run: () => "not json" }));
});

// --- hand-fix-ledger.ts: who authored what on main ----------------------------------------------------------------------------------------------

test("the commits of main since a time: every page, one tab-separated line each, an empty login kept as none", () => {
  const seen = recording("aaa\tDanBeckDev\nbbb\t\n\nccc\ta11ign-ai-workers\n");
  assert.deepEqual(mainCommitLoginsSince({ repo: "o/r", since: new Date("2026-09-03T00:00:00Z"), run: seen.run }), [
    { sha: "aaa", login: "DanBeckDev" }, { sha: "bbb", login: null }, { sha: "ccc", login: "a11ign-ai-workers" },
  ]);
  assert.deepEqual(seen.asked, [["api", "--paginate", "repos/o/r/commits?sha=main&since=2026-09-03T00:00:00.000Z&per_page=100", "--jq", '.[] | [.sha, (.author.login // "")] | @tsv']]);
  assert.throws(() => mainCommitLoginsSince({ repo: "o/r", since: new Date(0), run: () => { throw new Error("HTTP 403"); } }), /HTTP 403/);
});

test("the merged pull requests since a day are the merged-window connection read with author, title and body, a null author kept as none and a missing body empty", () => {
  const merged = [{ number: 77, mergedAt: "2026-09-30T10:00:00Z", author: { login: "a11ign-ai-workers" }, title: "x", body: "the body" },
    { number: 78, mergedAt: "2026-09-30T11:00:00Z", author: null, title: "y", body: null }];
  const seen = recording((args: string[]) => (readsRowsSince(args) === null ? new Error("unexpected") : JSON.parse(sinceAnswer(args, merged as never))));
  assert.deepEqual(rows().mergedPullsSince({ repo: "o/r", since: new Date("2026-09-03T12:00:00Z"), maxPages: 50, run: seen.run }), [
    { number: 77, author: "a11ign-ai-workers", title: "x", body: "the body" }, { number: 78, author: null, title: "y", body: "" },
  ]);
  const query = seen.asked[0].find((arg) => arg.startsWith("query=")) ?? "";
  assert.match(query, /number title body author\{login\} mergedAt/, "the fields the ledger reads");
  assert.ok(seen.asked.every((args) => !args.includes("--search")), "a connection read, never a search (#5076)");
  assert.throws(() => rows().mergedPullsSince({ repo: "o/r", since: new Date(0), maxPages: 1, run: () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
});

// --- fleet-gated-nightly.ts ----------------------------------------------------------------------------------------------------------------------

test("the open rows of a label are ONE listing of the repository at the limit it is given, with number and comments, and the answer is handed back as parsed", () => {
  const seen = recording([{ number: 5, comments: [] }]);
  assert.deepEqual(openRowsCarryingLabel({ repo: REPO, label: "fleet-gated", limit: 500, run: seen.run }), [{ number: 5, comments: [] }]);
  assert.deepEqual(seen.asked, [["issue", "list", "--repo", REPO, "--state", "open", "--label", "fleet-gated", "--json", "number,comments", "--limit", "500"]]);
  assert.ok(!seen.asked[0].includes("--milestone"), "#2443: an off-path row must be named too");
  assert.throws(() => openRowsCarryingLabel({ repo: REPO, label: "x", limit: 500, run: () => { throw new Error("gh: authentication required"); } }), /authentication required/);
  assert.throws(() => openRowsCarryingLabel({ repo: REPO, label: "x", limit: 500, run: () => "not json" }), SyntaxError);
});

// --- the labels the class-repeat and low-confidence filings put on (operations of earlier steps, asked here with these callers' argument lists) ------------------------------

test("a class label is made in the repository with --force (a second create is harmless) and its description, and put on a row as one edit of it", () => {
  const made = recording("");
  rows().ensureTriageLabel({ repo: "o/r", label: "class:copy-drift", description: "A class", run: made.run });
  assert.deepEqual(made.asked, [["label", "create", "class:copy-drift", "--repo", "o/r", "--force", "--description", "A class"]]);
  const put = recording("");
  rows().addLabelToRowIn({ repo: "o/r", number: 10, label: "class:copy-drift", run: put.run });
  assert.deepEqual(put.asked, [["issue", "edit", "10", "--repo", "o/r", "--add-label", "class:copy-drift"]]);
});
