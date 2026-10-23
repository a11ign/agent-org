// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 7): THE ARGUMENTS AND READINGS OF THE CLAIM'S RULES' GITHUB OPERATIONS, which core's tests of `src/row-claim/*-rule.ts` used to assert over a stubbed `run` and are the plugin's now (core's tests of
 * those rules run on the fake code host's rows). Each argument list below is copied from the rule that built it before it moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recording } from "./recording-run.test.support.ts";
import { rulesRows } from "./rules-rows.ts";

const REPO = "a11ign/a11ign";

test("the row reads send the argument lists the rules sent, and return GitHub's answer as it was", () => {
  const edge = recording({ blockedBy: { nodes: [{ number: 7, state: "OPEN" }] } });
  assert.deepEqual(rulesRows.blockedByOf({ repo: REPO, number: 12, run: edge.run }), { blockedBy: { nodes: [{ number: 7, state: "OPEN" }] } });
  assert.deepEqual(edge.asked, [["issue", "view", "12", "--repo", REPO, "--json", "blockedBy"]]);

  const body = recording({ body: "b", labels: [{ name: "ready" }] });
  assert.deepEqual(rulesRows.bodyAndLabelsOf({ repo: REPO, number: 12, run: body.run }), { body: "b", labels: [{ name: "ready" }] });
  assert.deepEqual(body.asked, [["issue", "view", "12", "--repo", REPO, "--json", "body,labels"]], "the claim's batched read serves this and the Region read from one call only while the argv is this one");
  assert.deepEqual(rulesRows.bodyAndLabelsOf({ repo: REPO, number: 12, run: recording({ labels: [] }).run }), { labels: [] }, "an answer with no body is returned as it is: the caller tells 'no body key' from an empty body");

  const label = recording({ labels: [{ name: "answer:ceo" }, {}] });
  assert.equal(rulesRows.rowCarriesLabel({ repo: REPO, number: 3, label: "answer:ceo", run: label.run }), true);
  assert.deepEqual(label.asked, [["issue", "view", "3", "--repo", REPO, "--json", "labels"]]);
  assert.equal(rulesRows.rowCarriesLabel({ repo: REPO, number: 3, label: "answer:ceo", run: recording({}).run }), false, "an answer with no label list is a row with none");
  assert.throws(() => rulesRows.rowCarriesLabel({ repo: REPO, number: 3, label: "x", run: recording(new Error("HTTP 502")).run }), /HTTP 502/, "a refused read is never 'not labelled'");
});

test("a held row's shape is two calls on one run: the view with its three fields, then the sub-issues", () => {
  const answers: Record<string, unknown> = { issue: { body: "## Region\n- a.ts", labels: [{ name: "in-progress" }], blockedBy: { nodes: [] } }, api: [{ number: 9 }, { number: 10 }] };
  const shape = recording((args: string[]) => answers[args[0]]);
  assert.deepEqual(rulesRows.rowShapeFactsOf({ repo: REPO, number: 5, run: shape.run }), { body: "## Region\n- a.ts", labels: [{ name: "in-progress" }], blockedBy: { nodes: [] }, subIssues: 2 });
  assert.deepEqual(shape.asked, [["issue", "view", "5", "--repo", REPO, "--json", "body,labels,blockedBy"], ["api", `repos/${REPO}/issues/5/sub_issues`]]);
  answers.api = { message: "not a list" };
  assert.equal(rulesRows.rowShapeFactsOf({ repo: REPO, number: 5, run: recording((args: string[]) => answers[args[0]]).run }).subIssues, 0, "an answer that is not a list is no sub-issues");
  assert.throws(() => rulesRows.rowShapeFactsOf({ repo: REPO, number: 5, run: recording((args: string[]) => (args[0] === "api" ? new Error("HTTP 404") : answers.issue)).run }), /HTTP 404/, "a refused sub-issue read refuses the whole shape");
});

test("the review-health reads: the list never asks for `commits`, and a pull request's commits are its own call", () => {
  const list = recording([{ number: 1, headRefOid: "a" }]);
  assert.deepEqual(rulesRows.openPullReviewsOf({ repo: REPO, limit: 200, run: list.run }), [{ number: 1, headRefOid: "a" }]);
  assert.deepEqual(list.asked, [["pr", "list", "--repo", REPO, "--state", "open", "--limit", "200", "--json", "number,headRefOid,reviewDecision,reviews,author"]]);
  assert.ok(!list.asked[0][list.asked[0].length - 1].split(",").includes("commits"), "#2316: GitHub refused the whole query when the list carried `commits`");

  const commits = recording({ commits: [{ messageHeadline: "fix" }] });
  assert.deepEqual(rulesRows.commitsOfPull({ repo: REPO, number: 4, run: commits.run }), [{ messageHeadline: "fix" }]);
  assert.deepEqual(commits.asked, [["pr", "view", "4", "--repo", REPO, "--json", "commits"]]);
  assert.deepEqual(rulesRows.commitsOfPull({ repo: REPO, number: 4, run: recording({}).run }), [], "an answer with no commit list is none");
});

test("B4's reads: one `pr list` for every open pull request's files, and REST's pages for a short listing", () => {
  const list = recording([{ number: 2, changedFiles: 1, files: [{ path: "a.ts" }] }]);
  assert.equal(rulesRows.openPullsWithFilesOf({ repo: "a11ign/nvda-worker", run: list.run }).length, 1);
  assert.deepEqual(list.asked, [["pr", "list", "--repo", "a11ign/nvda-worker", "--state", "open", "--json", "number,changedFiles,files,body,labels,headRefName"]]);

  const paged = recording("a.ts\nb.ts\n\n");
  assert.deepEqual(rulesRows.pullFilePathsOf({ repo: REPO, number: 8, run: paged.run }), ["a.ts", "b.ts"]);
  assert.deepEqual(paged.asked, [["api", "--paginate", `repos/${REPO}/pulls/8/files?per_page=100`, "--jq", ".[].filename"]]);
  assert.throws(() => rulesRows.pullFilePathsOf({ repo: REPO, number: 8, run: recording(new Error("HTTP 500")).run }), /HTTP 500/);
});

test("the closing pull requests are GitHub's own resolution, asked with the variables the rule sent", () => {
  const closing = recording({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [{ number: 5, state: "MERGED", headRefOid: "x" }] } } } } });
  assert.deepEqual(rulesRows.closingPullsOf({ repo: REPO, number: 77, run: closing.run }), [{ number: 5, state: "MERGED", headRefOid: "x" }]);
  const [args] = closing.asked;
  assert.deepEqual([args.slice(0, 3), args.slice(4)], [["api", "graphql", "-f"], ["-F", "owner=a11ign", "-F", "name=a11ign", "-F", "number=77"]]);
  assert.match(args[3], /^query=query\(\$owner:String!,\$name:String!,\$number:Int!\)\{repository\(owner:\$owner,name:\$name\)\{issue\(number:\$number\)\{closedByPullRequestsReferences\(first:5\)\{nodes\{number state headRefOid\}\}\}\}\}$/);
  assert.throws(() => rulesRows.closingPullsOf({ repo: REPO, number: 77, run: recording({ data: {} }).run }), TypeError, "an answer that is not that shape is a failed read, never 'no closing pull request'");
});

test("the delivery reads go to the END of the connection: the cursor is sent only once there is one, and a page with no `pageInfo` is a failed read", () => {
  const pages = [
    { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [{ source: { number: 1, state: "OPEN", body: "Delivers: #9" } }] },
    { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ source: {} }, { source: { number: 2, state: "MERGED", body: "" } }, {}] },
  ];
  let page = 0;
  const timeline = recording(() => ({ data: { repository: { issue: { timelineItems: pages[page++] } } } }));
  assert.deepEqual(rulesRows.crossReferencingPullsOf({ repo: REPO, number: 9, run: timeline.run }), [{ number: 1, state: "OPEN", body: "Delivers: #9" }, {}, { number: 2, state: "MERGED", body: "" }, {}]);
  assert.equal(timeline.asked.length, 2);
  assert.ok(!timeline.asked[0].some((arg) => arg.startsWith("after=")), "the first page sends no `after`: `-f after=` would send an empty string, a cursor GitHub rejects");
  assert.deepEqual(timeline.asked[1].slice(-2), ["-f", "after=c1"]);
  assert.match(timeline.asked[0][3], /timelineItems\(first:100,after:\$after,itemTypes:\[CROSS_REFERENCED_EVENT\]\)/);

  const files = recording(() => ({ data: { repository: { pullRequest: { files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "a.ts" }, { path: "b.ts" }] } } } } }));
  assert.deepEqual(rulesRows.changedPathsOfPull({ repo: REPO, number: 4, run: files.run }), ["a.ts", "b.ts"]);
  assert.match(files.asked[0][3], /files\(first:100,after:\$after\)\{pageInfo\{hasNextPage endCursor\}nodes\{path\}\}/);

  assert.throws(() => rulesRows.changedPathsOfPull({ repo: REPO, number: 4, run: recording(() => ({ data: { repository: { pullRequest: { files: { nodes: [] } } } } })).run }), /carried no `pageInfo`/);
  assert.throws(() => rulesRows.crossReferencingPullsOf({ repo: REPO, number: 4, run: recording(() => ({ data: { repository: { issue: { timelineItems: { pageInfo: { hasNextPage: true, endCursor: "same" }, nodes: [] } } } } })).run }), /did not end within 50 pages/, "a server that never says it has finished is bounded, and the bound is a failed read");
});

test("the writes send the argument lists the rule sent, and a refused one throws", () => {
  const writes = recording("");
  rulesRows.ensureLabelIn({ repo: REPO, name: "answer:ceo", run: writes.run });
  rulesRows.addLabelToRowIn({ repo: REPO, number: 12, label: "answer:ceo", run: writes.run });
  assert.deepEqual(writes.asked, [["label", "create", "answer:ceo", "--repo", REPO, "--force"], ["issue", "edit", "12", "--repo", REPO, "--add-label", "answer:ceo"]]);
  const refused = recording(new Error("HTTP 403"));
  assert.throws(() => rulesRows.ensureLabelIn({ repo: REPO, name: "x", run: refused.run }), /HTTP 403/);
  assert.throws(() => rulesRows.addLabelToRowIn({ repo: REPO, number: 1, label: "x", run: refused.run }), /HTTP 403/);
});

test("the compare of an installed copy asks for status and file names, and answers null for anything it cannot read", () => {
  const compare = recording({ status: "ahead", files: ["src/row-claim.ts"] });
  assert.deepEqual(rulesRows.compareShaWithMain({ repo: "a11ign/agent-org", sha: "abc", run: compare.run }), { status: "ahead", files: ["src/row-claim.ts"] });
  assert.deepEqual(compare.asked, [["api", "repos/a11ign/agent-org/compare/abc...main", "--jq", "{status: .status, files: [.files[].filename]}"]]);
  assert.equal(rulesRows.compareShaWithMain({ repo: "a/b", sha: "abc", run: recording(new Error("offline")).run }), null, "offline is CANNOT ASK");
  assert.equal(rulesRows.compareShaWithMain({ repo: "a/b", sha: "abc", run: recording("not json").run }), null);
  assert.equal(rulesRows.compareShaWithMain({ repo: "a/b", sha: "abc", run: recording({ status: "ahead" }).run }), null, "an answer of another shape is not 'nothing changed'");
});

// --- B2's delivery reads, to the END of their connections (#2026; they were asserted over a stubbed `gh` in `row-claim-own-pr-health-rule.test.ts`) ---

/** One page of a GraphQL connection as GitHub sends it: the cursor is the index of the page that follows. */
const connectionPage = (pages: unknown[][], index: number) => ({ nodes: pages[index] ?? [], pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) } });
const PAGE = 100;

/** Both reads served as PAGES: the timeline (no file lists at all), and the changed files of whichever pull request is asked about. */
function deliveryApi(timelinePages: unknown[][], filePages: Record<number, string[][]> = {}) {
  const cursor = (args: string[]) => Number(args.find((arg) => arg.startsWith("after="))?.slice("after=".length) ?? 0);
  return recording((args: string[]) => {
    if (args.join(" ").includes("timelineItems")) return { data: { repository: { issue: { timelineItems: connectionPage(timelinePages, cursor(args)) } } } };
    const number = Number(args.find((arg) => arg.startsWith("number="))?.slice("number=".length));
    const pages = (filePages[number] ?? [[]]).map((paths) => paths.map((path) => ({ path })));
    return { data: { repository: { pullRequest: { files: connectionPage(pages, cursor(args)) } } } };
  });
}
const source = (pr: { number: number; state: string; body: string }) => ({ source: pr });

test("#2026: the delivery lookup asks GitHub's own cross-reference events, not a search over bodies, and the timeline asks for no file lists", () => {
  // A search index lags the body edit the refusal has just told somebody to make; the timeline is computed server-side the moment the body is written.
  const api = deliveryApi([[]]);
  rulesRows.crossReferencingPullsOf({ repo: REPO, number: 2000, run: api.run });
  const query = api.asked[0].join(" ");
  assert.match(query, /CROSS_REFERENCED_EVENT/);
  assert.doesNotMatch(query, /\bsearch\(/, "a search query would be indexed minutes after the edit");
  assert.doesNotMatch(query, /files\(/, "the candidate set costs one page of numbers and bodies: a hundred nested file connections have no single cursor between them");
});

test("#2026: both queries ask for a FULL page, so paging is not paid for one node at a time", () => {
  const api = deliveryApi([[]], { 2011: [["a.ts"]] });
  rulesRows.crossReferencingPullsOf({ repo: REPO, number: 2000, run: api.run });
  rulesRows.changedPathsOfPull({ repo: REPO, number: 2011, run: api.run });
  assert.match(api.asked[0].join(" "), new RegExp(`timelineItems\\(first:${PAGE},`));
  assert.match(api.asked[1].join(" "), new RegExp(`files\\(first:${PAGE},`));
  assert.ok(api.asked[1].includes("number=2011"), "the files are read for the pull request asked about, not the row");
});

test("#2026: a delivery declared before a hundred more cross-references is still found", () => {
  const noise = (from: number) => Array.from({ length: PAGE }, (_, i) => source({ number: from + i, state: "MERGED", body: `mentions #2000 in passing (${from + i})` }));
  const api = deliveryApi([[source({ number: 2011, state: "OPEN", body: "Delivers: #2000" }), ...noise(3000).slice(1)], noise(4000), noise(5000)]);
  const found = rulesRows.crossReferencingPullsOf({ repo: REPO, number: 2000, run: api.run });
  assert.deepEqual(found[0], { number: 2011, state: "OPEN", body: "Delivers: #2000" }, "the declaration is 200 cross-references back; a single page of the timeline cannot see it");
  assert.equal(found.length, PAGE * 3, "all three pages, whole");
  assert.equal(api.asked.filter((args) => args.join(" ").includes("timelineItems")).length, 3, "three reads, so the read genuinely continued rather than the fixture flattening them");
});

test("#2026: a Region path after the hundredth changed file is still read", () => {
  const filler = (from: number) => Array.from({ length: PAGE }, (_, i) => `docs/note-${from + i}.md`);
  const api = deliveryApi([[]], { 2011: [filler(0), [...filler(100).slice(1), "packages/agent-org/host/units.mjs"]] });
  const paths = rulesRows.changedPathsOfPull({ repo: REPO, number: 2011, run: api.run });
  assert.ok(paths.includes("packages/agent-org/host/units.mjs"), "the only path the Region covers is on the second page of the file list");
  assert.equal(paths.length, PAGE * 2, "both pages, whole");
});

test("#2026: each page is asked with the cursor the one before it gave", () => {
  // Without this the loop re-reads page one until the bound trips: `hasNextPage` alone is not paging.
  const api = deliveryApi([[], [], []]);
  rulesRows.crossReferencingPullsOf({ repo: REPO, number: 2000, run: api.run });
  assert.deepEqual(api.asked.map((args) => args.find((arg) => arg.startsWith("after=")) ?? "after=<unsent>"), ["after=<unsent>", "after=1", "after=2"],
    "the first page sends no cursor at all — `-f after=` would send the empty STRING, which GitHub rejects");
});

test("#2026: a timeline with no `pageInfo` is a failed read, not the last page, and a connection that never ends is a failed read, not a short answer", () => {
  const shapeless = recording(() => ({ data: { repository: { issue: { timelineItems: { nodes: [] } } } } }));
  assert.throws(() => rulesRows.crossReferencingPullsOf({ repo: REPO, number: 2000, run: shapeless.run }), /carried no `pageInfo`/,
    "both queries ask for `pageInfo`, so its absence means the response is not the shape this code reads");
  const endless = recording(() => ({ data: { repository: { issue: { timelineItems: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "always-more" } } } } } }));
  assert.throws(() => rulesRows.crossReferencingPullsOf({ repo: REPO, number: 2000, run: endless.run }), /did not end within 50 pages/);
  assert.equal(endless.asked.length, 50, "and the bound is fifty pages");
});

test("a read that is not JSON is a failed read: the lookups above it read a throw as 'could not ask'", () => {
  assert.throws(() => rulesRows.bodyAndLabelsOf({ repo: REPO, number: 1, run: recording("not json").run }), SyntaxError);
  assert.throws(() => rulesRows.blockedByOf({ repo: REPO, number: 1, run: recording("not json").run }), SyntaxError);
});
