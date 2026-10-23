// no-token: none -- `run` answers from a recorded table or a stub: no GitHub CLI runs
/**
 * A11-160, step 8: THE BOARD'S READS AND POSTS, in GitHub's own words. The board DECIDES what a row, a milestone, a run or an edition means and what to do when a read is refused; its tests run on the fake code host
 * (`src/board-truth-audit.test.ts`, `src/packaging/board-data-issues-paging.test.ts`, `src/packaging/board-discussion.test.ts`, `src/packaging/board-outside.test.ts`, ...). What the argument lists say, which `--jq` filter
 * selects what, how a raw answer is parsed, what a failed `gh release view` means and what the GraphQL documents ask for are the operations', and are held here with a `run` that records the call and answers a table.
 * The cases were moved out of those core tests, each with the assertion it had.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const REPO = "a11ign/a11ign";

/** A `run` that keeps every argument list it was handed and answers `answer` (text, or a function of the arguments); a function that throws is a refused call. */
function recording(answer: string | ((args: string[]) => string) = "") {
  const calls: string[][] = [];
  const run: RowsRun = (args) => { calls.push([...args]); return typeof answer === "function" ? answer(args) : answer; };
  return { run, calls };
}
/** The value after `flag` in an argument list. */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
/** The `-f key=value` and `-F key=value` variables of a `gh api graphql` call, without the query. */
function variables(args: string[]): Record<string, string> {
  return Object.fromEntries(args.filter((a, i) => ["-f", "-F"].includes(args[i - 1]) && !a.startsWith("query=")).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
}
const queryOf = (args: string[]) => String(args.find((a) => a.startsWith("query=")) ?? "").slice("query=".length);
const refusal = (stderr: string) => Object.assign(new Error("Command failed: gh"), { status: 1, stderr });

// --- the issues, paged to exhaustion --------------------------------------------------------------------------------------------------------

test("issuePageOf: the first page sends no `after`, a later one sends the cursor as `after`, and the owner and name are the repository's two halves", () => {
  const page = { data: { repository: { issues: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
  const { run, calls } = recording(JSON.stringify(page));
  assert.deepEqual(rows().issuePageOf({ repo: "x/y", after: null, run }), page);
  assert.deepEqual(calls[0].slice(0, 2), ["api", "graphql"]);
  assert.deepEqual(variables(calls[0]), { owner: "x", name: "y" }, "no `after` variable on the first page");
  rows().issuePageOf({ repo: "x/y", after: "Y3Vyc29yOjEwMA==", run });
  assert.deepEqual(variables(calls[1]), { owner: "x", name: "y", after: "Y3Vyc29yOjEwMA==" });
});

test("issuePageOf: the document asks for the page the board reads (100 issues, the count, the cursor, each issue's labels and milestone), and an answer that is not JSON throws", () => {
  const { run, calls } = recording("{}");
  rows().issuePageOf({ repo: "x/y", after: null, run });
  const query = queryOf(calls[0]);
  assert.match(query, /issues\(first:100,after:\$after\)/);
  assert.match(query, /totalCount pageInfo\{hasNextPage endCursor\}/);
  assert.match(query, /nodes\{number title state createdAt closedAt url /);
  assert.match(query, /labels\(first:100\)\{totalCount nodes\{name\}\} milestone\{number title description dueOn\}/);
  assert.throws(() => rows().issuePageOf({ repo: "x/y", after: null, run: () => "not json" }), SyntaxError);
  assert.throws(() => rows().issuePageOf({ repo: "x/y", after: null, run: () => { throw refusal("HTTP 502"); } }), /Command failed/);
});

test("allMilestonesOf: every milestone, open and closed, over REST", () => {
  const { run, calls } = recording(JSON.stringify([{ number: 1, title: "v0.1.0 — first publish" }]));
  assert.deepEqual(rows().allMilestonesOf({ repo: REPO, run }), [{ number: 1, title: "v0.1.0 — first publish" }]);
  assert.deepEqual(calls, [["api", `repos/${REPO}/milestones?state=all`]]);
});

// --- the editions as Discussions --------------------------------------------------------------------------------------------------------------

test("the Discussion reads and writes send GraphQL documents of the right operation with the variables as `-f` fields, and answer the response's `data`", () => {
  const { run, calls } = recording(JSON.stringify({ data: { answered: true } }));
  assert.deepEqual(rows().discussionCategoriesOf({ owner: "a11ign", name: "a11ign", run }), { answered: true });
  assert.match(queryOf(calls[0]), /^query\(\$owner:String!,\$name:String!\)\{ repository\(owner:\$owner,name:\$name\)\{ id discussionCategories\(first:50\)\{ nodes\{ id slug \} \} \} \}$/);
  assert.deepEqual(variables(calls[0]), { owner: "a11ign", name: "a11ign" });

  rows().discussionEditionsOf({ owner: "a11ign", name: "a11ign", categoryId: "DIC_board", run });
  assert.match(queryOf(calls[1]), /discussions\(first:100,categoryId:\$categoryId,orderBy:\{field:CREATED_AT,direction:DESC\}\)\{ nodes\{ id title url \} \}/);
  assert.deepEqual(variables(calls[1]), { owner: "a11ign", name: "a11ign", categoryId: "DIC_board" }, "the lookup is scoped to the category");

  rows().createDiscussion({ repositoryId: "R_repo", categoryId: "DIC_board", title: "Board report — 2026-09-14", body: "# the edition\n\nverbatim", run });
  assert.match(queryOf(calls[2]), /^mutation\(\$repositoryId:ID!,\$categoryId:ID!,\$title:String!,\$body:String!\)\{ createDiscussion\(input:\{repositoryId:\$repositoryId,categoryId:\$categoryId,title:\$title,body:\$body\}\)\{ discussion\{ url \} \} \}$/);
  assert.deepEqual(variables(calls[2]), { repositoryId: "R_repo", categoryId: "DIC_board", title: "Board report — 2026-09-14", body: "# the edition\n\nverbatim" }, "the body travels verbatim");

  rows().updateDiscussion({ discussionId: "D_today", body: "the new body", run });
  assert.match(queryOf(calls[3]), /^mutation\(\$discussionId:ID!,\$body:String!\)\{ updateDiscussion\(input:\{discussionId:\$discussionId,body:\$body\}\)\{ discussion\{ url \} \} \}$/);
  assert.deepEqual(variables(calls[3]), { discussionId: "D_today", body: "the new body" });
});

test("a refused Discussion call throws (a GraphQL error exits non-zero as well as a refused request), so a failed read is never an empty list of editions", () => {
  const refused: RowsRun = () => { throw refusal("gh: GraphQL: Could not resolve to a Repository"); };
  assert.throws(() => rows().discussionEditionsOf({ owner: "a", name: "b", categoryId: "C", run: refused }), /Command failed/);
  assert.throws(() => rows().createDiscussion({ repositoryId: "R", categoryId: "C", title: "t", body: "b", run: refused }), /Command failed/);
  assert.throws(() => rows().discussionCategoriesOf({ owner: "a", name: "b", run: () => "not json" }), SyntaxError);
});

// --- the PDF as a draft release -------------------------------------------------------------------------------------------------------------------

test("draftReleaseOf: a tag with a release answers whether it is a draft; `release view` failing means there is no release, and so does an answer that is not JSON", () => {
  const { run, calls } = recording(JSON.stringify({ isDraft: true }));
  assert.deepEqual(rows().draftReleaseOf({ repo: REPO, tag: "board-2026-09-14", run }), { isDraft: true });
  assert.deepEqual(calls[0], ["release", "view", "board-2026-09-14", "--repo", REPO, "--json", "isDraft"]);
  assert.deepEqual(rows().draftReleaseOf({ repo: REPO, tag: "t", run: () => JSON.stringify({ isDraft: false }) }), { isDraft: false }, "CONTROL: a release that is not a draft is a release");
  assert.equal(rows().draftReleaseOf({ repo: REPO, tag: "t", run: () => { throw refusal("release not found"); } }), null);
  assert.equal(rows().draftReleaseOf({ repo: REPO, tag: "t", run: () => "<html>" }), null);
});

test("createDraftRelease creates a DRAFT with the file attached, titled and noted; uploadReleaseAsset replaces an asset of the same name", () => {
  const { run, calls } = recording();
  rows().createDraftRelease({ repo: REPO, tag: "board-2026-09-14", file: "/tmp/edition.pdf", title: "Board report — 2026-09-14", notes: "the notes", run });
  assert.deepEqual(calls[0], ["release", "create", "board-2026-09-14", "/tmp/edition.pdf", "--repo", REPO, "--draft", "--title", "Board report — 2026-09-14", "--notes", "the notes"]);
  rows().uploadReleaseAsset({ repo: REPO, tag: "board-2026-09-14", file: "/tmp/edition.pdf", run });
  assert.deepEqual(calls[1], ["release", "upload", "board-2026-09-14", "/tmp/edition.pdf", "--repo", REPO, "--clobber"]);
  assert.throws(() => rows().createDraftRelease({ repo: REPO, tag: "t", file: "f", title: "t", notes: "n", run: () => { throw refusal("HTTP 422"); } }), /Command failed/);
});

// --- the rows listed, the window of rows touched, the editions posted ------------------------------------------------------------------------

test("rowsListedIn and pullsListedIn list the newest `limit` in the state with the JSON fields named, and parse the list", () => {
  const { run, calls } = recording(JSON.stringify([{ number: 7 }]));
  assert.deepEqual(rows().rowsListedIn({ repo: REPO, state: "open", limit: 1000, fields: "number,title,body,labels,state,comments,subIssuesSummary,createdAt,blockedBy", run }), [{ number: 7 }]);
  assert.deepEqual(calls[0], ["issue", "list", "--repo", REPO, "--state", "open", "--limit", "1000", "--json", "number,title,body,labels,state,comments,subIssuesSummary,createdAt,blockedBy"],
    "the standalone read asks for blockedBy, so the seventh question is read there too");
  rows().pullsListedIn({ repo: REPO, state: "merged", limit: 200, fields: "number,body,mergedAt", run });
  assert.deepEqual(calls[1], ["pr", "list", "--repo", REPO, "--state", "merged", "--limit", "200", "--json", "number,body,mergedAt"]);
  assert.ok(/(^|,)mergedAt(,|$)/.test(after(calls[1], "--json")), "every merged-PR read asks for mergedAt");
  assert.throws(() => rows().rowsListedIn({ repo: REPO, state: "closed", limit: 500, fields: "number", run: () => "not json" }), SyntaxError);
  assert.throws(() => rows().pullsListedIn({ repo: REPO, state: "merged", limit: 200, fields: "number", run: () => { throw refusal("HTTP 502"); } }), /Command failed/);
});

test("windowRowsTextOf pages REST for the issues updated since, drops pull requests, and prints one object per line in the listing shape", () => {
  const { run, calls } = recording("{\"number\":1}\n");
  assert.equal(rows().windowRowsTextOf({ repo: REPO, since: "2026-10-07T12:00:00.000Z", run }), "{\"number\":1}\n");
  assert.deepEqual(calls[0].slice(0, 3), ["api", "--paginate", `repos/${REPO}/issues?state=all&since=2026-10-07T12:00:00.000Z&per_page=100`]);
  const jq = after(calls[0], "--jq");
  assert.match(jq, /select\(\.pull_request == null\)/, "a pull request carries a pull_request key and is left out");
  assert.match(jq, /state: \(\.state \| ascii_upcase\)/);
  assert.match(jq, /createdAt: \.created_at, closedAt: \.closed_at, labels: \[\.labels\[\] \| \{ name \}\]/);
});

test("editionCommentCountOf: the comments since, by title, over REST with the title in the filter; the count is summed over the pages, and a page that prints a non-count adds nothing", () => {
  const title = "# Board report — 2026-10-16";
  const asked = recording("0\n0\n");
  assert.equal(rows().editionCommentCountOf({ repo: REPO, issue: "20", since: "2026-10-14T07:10:00.000Z", title, run: asked.run }), 0, "no comment of today's title on any page");
  assert.deepEqual(asked.calls[0].slice(0, 3), ["api", "--paginate", `repos/${REPO}/issues/20/comments?since=2026-10-14T07:10:00.000Z&per_page=100`]);
  assert.ok(after(asked.calls[0], "--jq").includes(`startswith(${JSON.stringify(title)})`), "the title is the one `render` writes");
  assert.equal(rows().editionCommentCountOf({ repo: REPO, issue: "20", since: "s", title, run: () => "0\n1\n" }), 1, "one on the second page");
  assert.equal(rows().editionCommentCountOf({ repo: REPO, issue: "20", since: "s", title, run: () => "2\n3\n0\n" }), 5, "summed over the pages");
  assert.equal(rows().editionCommentCountOf({ repo: REPO, issue: "20", since: "s", title, run: () => "x\n-1\n\n" }), 0, "a line that is not a count is not one");
  assert.throws(() => rows().editionCommentCountOf({ repo: REPO, issue: "20", since: "s", title, run: () => { throw refusal("HTTP 502"); } }), /Command failed/);
});

test("commentBodiesOfIssue: the bodies of the comments of a row, from `issue view --json comments`", () => {
  const { run, calls } = recording(JSON.stringify({ comments: [{ body: "one" }, { body: "no summary for 2026-10-16" }] }));
  assert.deepEqual(rows().commentBodiesOfIssue({ repo: REPO, number: "20", run }), ["one", "no summary for 2026-10-16"]);
  assert.deepEqual(calls[0], ["issue", "view", "20", "--repo", REPO, "--json", "comments"]);
  assert.throws(() => rows().commentBodiesOfIssue({ repo: REPO, number: 20, run: () => "not json" }), SyntaxError);
});

// --- the schedule's liveness ----------------------------------------------------------------------------------------------------------------------

test("workflowRunListOf names the workflow with `--workflow` (the file, as given), the fields and the limit; workflowCreatedAtOf reads `created_at` of the workflow", () => {
  const { run, calls } = recording(JSON.stringify([{ createdAt: "2026-09-09T17:59:00Z" }]));
  assert.deepEqual(rows().workflowRunListOf({ repo: REPO, workflow: "trunk.yml", fields: "createdAt", limit: 2, run }), [{ createdAt: "2026-09-09T17:59:00Z" }]);
  assert.deepEqual(calls[0], ["run", "list", "--repo", REPO, "--workflow", "trunk.yml", "--json", "createdAt", "--limit", "2"]);
  assert.equal(calls[0].includes("board-liveness.yml"), false, "a name that is not the one given is never asked");
  const created = recording(JSON.stringify({ created_at: "2026-09-06T16:23:01.000+01:00" }));
  assert.equal(rows().workflowCreatedAtOf({ repo: REPO, workflow: "board-report.yml", run: created.run }), "2026-09-06T16:23:01.000+01:00");
  assert.deepEqual(created.calls[0], ["api", `repos/${REPO}/actions/workflows/board-report.yml`]);
  assert.equal(rows().workflowCreatedAtOf({ repo: REPO, workflow: "w", run: () => "{}" }), null, "no date from GitHub is null, not undefined");
});

// --- the truth audit --------------------------------------------------------------------------------------------------------------------------------

test("roadmapFactsOf: ONE aliased request for the rows asked, each with its parent and grandparent, naming the `Roadmap` field; the answer is the repository's", () => {
  const answer = { r1: { number: 1 }, r2: null };
  const { run, calls } = recording(JSON.stringify({ data: { repository: answer } }));
  assert.deepEqual(rows().roadmapFactsOf({ repo: "a11ign/agent-org", numbers: [1, 2], run }), answer);
  assert.equal(calls.length, 1);
  const query = queryOf(calls[0]);
  assert.deepEqual([...query.matchAll(/\br(\d+): issue\(number: (\d+)\)/g)].map((m) => [m[1], m[2]]), [["1", "1"], ["2", "2"]], "an alias per row, named by its number");
  assert.match(query, /r1: issue\(number: 1\) \{ \.\.\.F parent \{ \.\.\.F parent \{ \.\.\.F \} \} \}/, "the row, its parent and its grandparent");
  assert.match(query, /fieldValueByName\(name: "Roadmap"\)/);
  assert.match(query, /projectItems\(first: 20\) \{ totalCount nodes/, "the count is asked, so a cut-short page is told from a whole one");
  assert.deepEqual(variables(calls[0]), { owner: "a11ign", name: "agent-org" });
});

test("roadmapFactsOf: an answer with no repository (a list, a null, a missing `data`) THROWS, so it is never an empty map every row agrees with", () => {
  for (const unreadable of ["[]", JSON.stringify({ data: { repository: null } }), JSON.stringify({ errors: [{ message: "rate limited" }] }), JSON.stringify({ data: { repository: [] } })]) {
    assert.throws(() => rows().roadmapFactsOf({ repo: "a/b", numbers: [1], run: () => unreadable }), /roadmap read: no repository in the answer/, unreadable);
  }
  assert.throws(() => rows().roadmapFactsOf({ repo: "a/b", numbers: [1], run: () => { throw refusal("HTTP 502"); } }), /Command failed/);
  assert.throws(() => rows().roadmapFactsOf({ repo: "a/b", numbers: [1], run: () => "not json" }), SyntaxError);
});

test("commentAuthorOf: the login that posted a comment, from the comment's own REST path, trimmed", () => {
  const { run, calls } = recording("DanBeckDev\n");
  assert.equal(rows().commentAuthorOf({ repo: "a/b", id: "9010", run }), "DanBeckDev");
  assert.deepEqual(calls[0], ["api", "repos/a/b/issues/comments/9010", "--jq", ".user.login"]);
  assert.throws(() => rows().commentAuthorOf({ repo: "a/b", id: "9010", run: () => { throw refusal("HTTP 404"); } }), /Command failed/);
});

test("headedCommentIdsText: the ids of the comments of a row since a time that open with a heading, one page of the day before, filtered by the day's own heading", () => {
  const { run, calls } = recording("4242\n");
  assert.equal(rows().headedCommentIdsText({ repo: "a/b", row: "928", since: "2026-10-07T00:00:00Z", heading: "### Board against reality, 2026-10-08", run }), "4242\n");
  assert.deepEqual(calls[0].slice(0, 3), ["api", "--paginate", "repos/a/b/issues/928/comments?per_page=100&since=2026-10-07T00:00:00Z"]);
  assert.match(after(calls[0], "--jq"), /startswith\("### Board against reality, 2026-10-08"\)/);
  assert.match(after(calls[0], "--jq"), /\| \.id$/);
  assert.throws(() => rows().headedCommentIdsText({ repo: "a/b", row: "928", since: "s", heading: "h", run: () => { throw refusal("HTTP 403"); } }), /403|Command failed/);
});

test("orgCommentsSinceOf, issuesSinceOf and labeledEventsOfRow page REST, filter with `--jq`, and parse one JSON object per line", () => {
  const comment = { number: 4090, author: { login: "a11ign-ai-leads" }, body: "a comment", createdAt: "2026-10-08T10:22:00Z", url: "https://github.com/a/b/issues/4090#issuecomment-1" };
  const comments = recording(`${JSON.stringify(comment)}\n${JSON.stringify({ ...comment, number: 4091 })}\n`);
  assert.deepEqual(rows().orgCommentsSinceOf({ repo: "a/b", since: "2026-10-07T12:00:00Z", loginPrefix: "a11ign-", run: comments.run }).map((c) => c.number), [4090, 4091]);
  assert.deepEqual(comments.calls[0].slice(0, 3), ["api", "--paginate", "repos/a/b/issues/comments?since=2026-10-07T12:00:00Z&per_page=100"]);
  assert.match(after(comments.calls[0], "--jq"), /select\(\.user\.login \| startswith\("a11ign-"\)\)/);
  assert.match(after(comments.calls[0], "--jq"), /number: \(\.issue_url \| split\("\/"\) \| last \| tonumber\)/);

  const issue = { number: 4090, state: "open", author: "a11ign-ai-workers", createdAt: "2026-10-08T09:00:00Z", text: "title\nbody" };
  const issues = recording(`${JSON.stringify(issue)}\n\n`);
  assert.deepEqual(rows().issuesSinceOf({ repo: "a/b", since: "2026-10-07T12:00:00Z", run: issues.run }), [issue], "a blank line is no object");
  assert.deepEqual(issues.calls[0].slice(0, 3), ["api", "--paginate", "repos/a/b/issues?state=all&since=2026-10-07T12:00:00Z&per_page=100"]);
  assert.match(after(issues.calls[0], "--jq"), /select\(\.pull_request \| not\)/, "pull requests are left out");

  const event = { number: 4090, label: "answer:ceo", actor: "a11ign-ai-leads", createdAt: "2026-10-08T10:27:00Z" };
  const events = recording(`${JSON.stringify(event)}\n`);
  assert.deepEqual(rows().labeledEventsOfRow({ repo: "a/b", number: 4090, run: events.run }), [event]);
  assert.deepEqual(events.calls[0].slice(0, 3), ["api", "--paginate", "repos/a/b/issues/4090/events?per_page=100"]);
  assert.match(after(events.calls[0], "--jq"), /select\(\.event == "labeled"\)/);
  assert.match(after(events.calls[0], "--jq"), /number: 4090, label: \.label\.name, actor: \.actor\.login, createdAt: \.created_at/);

  assert.throws(() => rows().labeledEventsOfRow({ repo: "a/b", number: 4090, run: () => "{ not json" }), SyntaxError, "a line that is not JSON is a read that failed, not an empty history");
  assert.throws(() => rows().issuesSinceOf({ repo: "a/b", since: "s", run: () => { throw refusal("HTTP 502"); } }), /Command failed/);
});
