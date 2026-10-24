// module: the GitHub plugin's rows for the closing section of the contract (A11-160, step 9; moved from the callers named in each operation's comment)
//
// Each operation builds the argument list its caller built and reads GitHub's answer as the caller did, and THROWS when `gh` refuses: what a caller does with a refusal stays in core. `run` is the caller's executor
// where it has one; absent, the code host runs `gh` itself (`runners.own`).
import type { CodeHostRows, RowsHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { ClaimedRowsPage, PullHeadRead, RowsClosing, WorkerStateRow } from "../../../src/plugins/contracts/code-host-rows-closing.ts";
import type { RowsRunners } from "./index.ts";
import { closedRowPageOf } from "./closed-row-page.ts";
import { buildRowOf, mergedPullClosingOf, closingRowsOfMergedPull, declaredBuildRowOf, declaredRowOf } from "./closing-pull-reads.ts";
import { withOwnRun } from "./with-own-run.ts";

/** A comment of a row as the claim record is read from it. */
type RowComment = ReturnType<RowsClosing["commentsOfRowIn"]>[number];

/** The operations of this section. */
export type ClosingRows = Pick<CodeHostRows, keyof RowsClosing>;

/** The minimal GraphQL call the close paths read their rate-limit headers off: `rateLimit` costs effectively nothing, and `--include` prints the headers of the response that served it. */
export function rateLimitDumpOf({ run }: { run: RowsRun }): string {
  return run(["api", "graphql", "-f", "query=query{rateLimit{limit cost remaining resetAt}}", "--include"]);
}

/** Closes row `row` of `repo` as COMPLETED, leaving `comment` on it. */
export function closeCompletedRow({ repo, row, comment, run }: { repo: string; row: number; comment: string; run: RowsRun }): void {
  run(["issue", "close", String(row), "--repo", repo, "--comment", comment, "--reason", "completed"]);
}

export function rowNumberStateAndLabelsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { number: number; state: string; labels: string[] } {
  const row = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "number,state,labels"]));
  return { number: row.number, state: row.state, labels: (row.labels ?? []).map((label: { name: string }) => label.name) };
}

/** A row that carries no `labels` is a row this cannot read: it THROWS rather than answer no claim. */
export function rowStateAndLabelsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { state: string; labels: string[] } {
  const read = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "state,labels"]));
  return { state: read.state, labels: read.labels.map((label: { name: string }) => label.name) };
}

export function commentsOfRowIn({ repo, number, run }: { repo: string; number: number; run: RowsRun }): RowComment[] {
  return JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "comments"])).comments ?? [];
}

/** `repo/issues/<n>` carries the row's id, which the sub-issue call names (the number is not what it takes). */
const idOfRow = (repo: string, number: number, run: RowsRun): string => run(["api", `repos/${repo}/issues/${number}`, "--jq", ".id"]).trim();

export function fileRowInMilestone({ repo, title, body, labels, milestone, run }: { repo: string; title: string; body: string; labels: readonly string[]; milestone: string | null; run: RowsRun }): number {
  const url = run(["issue", "create", "--repo", repo, "--title", title, "--body", body, ...labels.flatMap((label) => ["--label", label]), ...(milestone === null ? [] : ["--milestone", milestone])]);
  const made = /\/issues\/(\d+)\s*$/.exec(url);
  if (!made) throw new Error(`gh issue create answered no issue URL: ${url}`);
  return Number(made[1]);
}

export function addBlockedByEdge({ repo, row, blocker, run }: { repo: string; row: number; blocker: number; run: RowsRun }): void {
  run(["issue", "edit", String(row), "--repo", repo, "--add-blocked-by", String(blocker)]);
}

export function addSubIssueTo({ repo, parent, child, run }: { repo: string; parent: number; child: number; run: RowsRun }): void {
  run(["api", "-X", "POST", `repos/${repo}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${idOfRow(repo, child, run)}`]);
}

/** The open rows carrying `label`, each with its newest `window` comments, in ONE query. */
export function claimedRowsWithComments({ repo, label, count, window, run }: { repo: string; label: string; count: number; window: number; run: RowsRun }): ClaimedRowsPage {
  const [owner, name] = repo.split("/");
  const query = "query($owner:String!,$name:String!,$label:String!,$count:Int!,$window:Int!){"
    + "repository(owner:$owner,name:$name){issues(states:OPEN,labels:[$label],first:$count){totalCount nodes{number "
    + "comments(last:$window){totalCount nodes{body createdAt author{login}}}}}}}";
  const issues = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`,
    "-F", `label=${label}`, "-F", `count=${count}`, "-F", `window=${window}`])).data.repository.issues;
  return { total: issues.totalCount, rows: issues.nodes.map((issue: { number: number; comments: { totalCount: number; nodes: RowComment[] } }) => ({ number: issue.number, comments: issue.comments.nodes, commentsTotal: issue.comments.totalCount })) };
}

/** The pull request by REST (`core`, not the GraphQL pool a closing-reference lookup spends). */
export function headBranchAndForkOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): PullHeadRead {
  const pull = JSON.parse(run(["api", `repos/${repo}/pulls/${number}`]));
  if (typeof pull.head.ref !== "string" || pull.head.ref === "") throw new Error("the PR names no head branch");
  return { branch: pull.head.ref, fork: pull.head.repo?.full_name !== pull.base.repo.full_name };
}

/** ONE file of `repo`, raw: with no `ref` GitHub answers from the default branch (agent-org#839: the detector reads a file AS A MERGE LEFT IT, and a caller's `ref` is a validated commit oid). */
export function consumerFileTextOf({ repo, path, ref, run }: { repo: string; path: string; ref?: string; run: RowsRun }): string {
  const at = ref === undefined ? "" : `?ref=${ref}`;
  return run(["api", `repos/${repo}/contents/${path}${at}`, "-H", "Accept: application/vnd.github.raw"]);
}

/** GitHub's word for an issue that does not exist, in whichever of its forms the CLI prints. */
const NO_SUCH_ISSUE = /Could not resolve to an? (?:Issue|issue)|not found|no issue/i;

/** One call for the row's state, labels, comments and body; "no such issue" is `null` and any other failure is thrown. */
export function rowWithCommentsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): WorkerStateRow | null {
  let out: string;
  try {
    out = run(["issue", "view", String(number), "--repo", repo, "--json", "state,labels,comments,body"]);
  } catch (err: any) {
    if (NO_SUCH_ISSUE.test(String(err?.stderr ?? err?.message ?? ""))) return null;
    throw err;
  }
  const parsed = JSON.parse(out) as { state: string; body?: string; labels?: { name: string }[]; comments?: { id: string; url: string; body: string; createdAt: string }[] };
  // A reply with no comments cannot answer the ruling check, and "no comments" would read as "no ruling": so it THROWS (the row is unreadable, nothing is labelled).
  if (!Array.isArray(parsed.comments)) throw new Error(`gh issue view of #${number} of ${repo} carried no comments field, so no ruling can be read`);
  return {
    state: parsed.state === "OPEN" ? "OPEN" : "CLOSED",
    labels: (parsed.labels ?? []).map((label) => label.name),
    comments: parsed.comments.map(({ id, url, body, createdAt }) => ({ id, url, body, createdAt })),
    body: parsed.body ?? "",
  };
}

export function closingRowsOf(runners: RowsRunners, _helpers: () => RowsHelpers): ClosingRows {
  const own = runners.own;
  return {
    rateLimitDumpOf: withOwnRun(rateLimitDumpOf, own), closeCompletedRow: withOwnRun(closeCompletedRow, own), rowNumberStateAndLabelsOf: withOwnRun(rowNumberStateAndLabelsOf, own),
    rowStateAndLabelsOf: withOwnRun(rowStateAndLabelsOf, own), commentsOfRowIn: withOwnRun(commentsOfRowIn, own), declaredRowOf: withOwnRun(declaredRowOf, own),
    declaredBuildRowOf: withOwnRun(declaredBuildRowOf, own), buildRowOf: withOwnRun(buildRowOf, own), mergedPullClosingOf: withOwnRun(mergedPullClosingOf, own),
    closingRowsOfMergedPull: withOwnRun(closingRowsOfMergedPull, own), fileRowInMilestone: withOwnRun(fileRowInMilestone, own), addBlockedByEdge: withOwnRun(addBlockedByEdge, own),
    addSubIssueTo: withOwnRun(addSubIssueTo, own), closedRowPageOf: withOwnRun(closedRowPageOf, own), claimedRowsWithComments: withOwnRun(claimedRowsWithComments, own),
    headBranchAndForkOf: withOwnRun(headBranchAndForkOf, own), consumerFileTextOf: withOwnRun(consumerFileTextOf, own), rowWithCommentsOf: withOwnRun(rowWithCommentsOf, own),
  };
}
