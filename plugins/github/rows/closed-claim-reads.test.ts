// no-token: none -- `run` answers from a recorded table of REST paths: no GitHub CLI runs
/**
 * agent-org#1113, #948 (moved here by A11-160, step 6): THE CLOSED-CLAIM READ IS OVER REST, and how it reads GitHub's answers. What the gate DECIDES of the rows it returns, and what it SAYS about a refusal, are core's and
 * their tests run on the fake code host (`src/closed-claim-rest-read.test.ts`, `src/closed-claim-unread-cause.test.ts`); the paths asked, the paging of the comments, the `--slurp` of the timeline, the 404 that is an absent row and
 * the body that is not JSON are the operation's, `closedClaimedRowsOf`, and are held here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const REPO = "a11ign/agent-org";
const CLAIM = [{ name: "in-progress" }, { name: "started" }, { name: "session:worker-5011" }];
const issue = (number: number, state: "open" | "closed", labels: { name: string }[], comments = 0) => ({ number, state, labels, comments });
const comment = (body: string, login = "a11ign-ai-workers") => ({ body, created_at: "2026-10-12T19:30:00Z", user: { login } });
const pathOf = (args: string[]) => args[args.length - 1].replace(/^repos\/[^/]+\/[^/]+\//, "");

/**
 * A `gh` seam answering the REST paths in `answers` (keyed by the path after `repos/<owner>/<name>/`, query included). Any other path is a 404, and a `graphql` argument is refused as a 403, so a read that still
 * reaches GraphQL is refused.
 */
function seam(answers: Record<string, unknown>, refuse: Record<string, string> = {}) {
  const calls: { args: string[]; aimed: string | undefined }[] = [];
  const run = (args: string[], aimed?: string) => {
    calls.push({ args, aimed });
    if (args.includes("graphql")) throw Object.assign(new Error("Command failed: gh api graphql"), { status: 1, stderr: "HTTP 403: graphql is refused in this test" });
    const path = pathOf(args);
    if (path in refuse) throw Object.assign(new Error("Command failed: gh api"), { status: 1, stderr: refuse[path] });
    if (!(path in answers)) throw Object.assign(new Error("Command failed: gh api"), { status: 1, stderr: "gh: Not Found (HTTP 404)" });
    return JSON.stringify(answers[path]);
  };
  return { calls, run };
}

const read = (numbers: number[], run: (args: string[], repo?: string) => string, aim?: string) => rows().closedClaimedRowsOf({ repo: REPO, aim, numbers, claimLabel: "in-progress", run });

test("#1113 (1) a closed claimed row comes back with its labels, its last comments and the pull request that cross-referenced it, over REST only", () => {
  const { calls, run } = seam({
    "issues/5011": issue(5011, "closed", CLAIM, 1),
    "issues/5011/comments?per_page=100&page=1": [comment("the claim record")],
    "issues/5011/timeline": [{ event: "labeled" }, { event: "cross-referenced", source: { issue: { number: 412, title: "the fix", pull_request: {} } } }],
    "pulls/412": { head: { ref: "agent/a-fix-5011" } },
  });
  assert.deepEqual(read([5011], run), [{ number: 5011, labels: CLAIM, comments: [{ body: "the claim record", createdAt: "2026-10-12T19:30:00Z", author: { login: "a11ign-ai-workers" } }],
    closedByPullRequestsReferences: [{ number: 412, headRefName: "agent/a-fix-5011", title: "the fix" }] }]);
  assert.ok(calls.every(({ args }) => !args.includes("graphql")), "no GraphQL call is made on this path");
  assert.deepEqual(calls.map(({ args }) => pathOf(args)), ["issues/5011", "issues/5011/comments?per_page=100&page=1", "issues/5011/timeline", "pulls/412"]);
});

test("#1113 (2) an open row, a closed row without the claim and an absent row are dropped, and only their issue is ever read; an absent row (HTTP 404) is no claim, not a refusal", () => {
  const { calls, run } = seam({ "issues/5011": issue(5011, "open", CLAIM), "issues/5012": issue(5012, "closed", [{ name: "started" }], 3) });
  assert.deepEqual(read([5011, 5012, 5013], run), []);
  assert.deepEqual(calls.map(({ args }) => pathOf(args)), ["issues/5011", "issues/5012", "issues/5013"], "the comments and the timeline are read only for a closed claimed row");
});

test("#1113 (3, 4) a refused issue read, and a refused comments read, THROW: a closed claimed row whose record cannot be read is not returned without it", () => {
  assert.throws(() => read([5011], seam({}, { "issues/5011": "HTTP 502: Bad Gateway" }).run), (error: { stderr?: string }) => error.stderr === "HTTP 502: Bad Gateway");
  const comments = seam({ "issues/5011": issue(5011, "closed", CLAIM, 1) }, { "issues/5011/comments?per_page=100&page=1": "HTTP 502: Bad Gateway" });
  assert.throws(() => read([5011], comments.run), (error: { stderr?: string }) => error.stderr === "HTTP 502: Bad Gateway");
});

test("#1113 (6) a keyed tracker's rows are read in that tracker's repository, every call aimed at it", () => {
  const { calls, run } = seam({
    "issues/730": issue(730, "closed", [{ name: "in-progress" }, { name: "session:worker-agent-org-730" }], 1),
    "issues/730/comments?per_page=100&page=1": [comment("the claim record")],
    "issues/730/timeline": [],
  });
  assert.deepEqual(read([730], run, REPO).map((row) => row.number), [730]);
  assert.deepEqual(calls.map(({ args }) => args.at(-1)), [`repos/${REPO}/issues/730`, `repos/${REPO}/issues/730/comments?per_page=100&page=1`, `repos/${REPO}/issues/730/timeline`], "every call names the tracker's repository");
  assert.ok(calls.every(({ aimed }) => aimed === REPO), "and is aimed at it");
});

test("#1113 (7) the comments read is the LAST 100, as GraphQL's `comments(last: 100)` gave them: a row with 150 comments reads pages 1 and 2 and keeps 51 to 150", () => {
  const pages = Array.from({ length: 150 }, (_, i) => comment(`c${i + 1}`));
  const { calls, run } = seam({
    "issues/5011": issue(5011, "closed", CLAIM, 150),
    "issues/5011/comments?per_page=100&page=1": pages.slice(0, 100),
    "issues/5011/comments?per_page=100&page=2": pages.slice(100),
    "issues/5011/timeline": [],
  });
  const [row] = read([5011], run);
  assert.equal(row.comments.length, 100);
  assert.deepEqual([row.comments[0]?.body, row.comments.at(-1)?.body], ["c51", "c150"]);
  assert.deepEqual(calls.map(({ args }) => pathOf(args)), ["issues/5011", "issues/5011/comments?per_page=100&page=1", "issues/5011/comments?per_page=100&page=2", "issues/5011/timeline"]);
});

test("#1113 (8) a timeline on two pages is read whole: `gh api --paginate` prints one array per page back to back, so the read asks for --slurp and flattens the pages", () => {
  const firstPage = Array.from({ length: 100 }, (_, i) => ({ event: "labeled", id: i }));
  const secondPage = [{ event: "cross-referenced", source: { issue: { number: 412, title: "the fix", pull_request: {} } } }];
  const answers: Record<string, unknown> = { "issues/5011": issue(5011, "closed", CLAIM, 1), "issues/5011/comments?per_page=100&page=1": [comment("the claim record")], "pulls/412": { head: { ref: "agent/a-fix-5011" } } };
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const path = pathOf(args);
    if (path === "issues/5011/timeline" && args.includes("--slurp")) return JSON.stringify([firstPage, secondPage]);
    if (path === "issues/5011/timeline" && args.includes("--paginate")) return `${JSON.stringify(firstPage)}\n${JSON.stringify(secondPage)}`;
    if (path in answers) return JSON.stringify(answers[path]);
    throw Object.assign(new Error("Command failed: gh api"), { status: 1, stderr: "gh: Not Found (HTTP 404)" });
  };
  assert.deepEqual(read([5011], run)[0]?.closedByPullRequestsReferences, [{ number: 412, headRefName: "agent/a-fix-5011", title: "the fix" }], "the cross-reference on the second page is found, not refused as invalid JSON");
  assert.ok(calls.some((args) => args.includes("--slurp")), "the timeline is asked for with --slurp");
});

test("#948 (2, 3) an answer that is not JSON THROWS, saying so, on the issue read and on the timeline read", () => {
  assert.throws(() => read([5011], () => "garbage"), /^Error: its answer was not JSON/);
  const answers = { "issues/5011": JSON.stringify(issue(5011, "closed", CLAIM)), "issues/5011/comments?per_page=100&page=1": "[]", "issues/5011/timeline": "<html>bad gateway</html>" } as Record<string, string>;
  assert.throws(() => read([5011], (args) => answers[pathOf(args)]), /^Error: its answer was not JSON/);
});
