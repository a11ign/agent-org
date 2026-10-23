// module: the GitHub reads of CLOSED rows that the work gate asks (A11-160, step 6; moved from `src/work-gate/causes/`)
//
// Two questions of closed rows: which of a listed worker's own rows closed while still carrying the claim (read by number over REST, with the comments the claim record is read from and the pull requests that
// cross-reference each), and which closed rows or pull requests still carry an `answer:` label (one aliased GraphQL read). What the gate DECIDES of them is core's; the commands and the reading of the answers
// are here. Each takes the `run` the gate hands it (the contract's head says why).
import type { AimedRun, ClosedLabelledRow, CodeHostRows, RowsReadHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** A closed row that still carries the claim, with the comments the claim record is read from and the pull requests that cross-reference it. */
type ClosedClaimedRead = ReturnType<CodeHostRows["closedClaimedRowsOf"]>[number];
import { readUnlessRefused } from "./rows-by-label.ts";

/** A REST answer as JSON. An answer that is not JSON is a refusal, named as one (#948). */
function json(text: string): any {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`its answer was not JSON (${String((error as Error)?.message ?? error).trim().split("\n")[0]})`);
  }
}

/** A row `gh` answers HTTP 404 for is an absent row, which is no claim (as GraphQL's `issue: null` was). Any other refusal is the whole read's. */
function absentIsNull<T>(get: () => T): T | null {
  try {
    return get();
  } catch (error) {
    if (/HTTP 404/.test(String((error as { stderr?: unknown } | undefined)?.stderr ?? ""))) return null;
    throw error;
  }
}

/** The last 100 comments, as `comments(last: 100)` gave them. REST pages oldest first, so the last two pages (from the issue's own count) hold them. */
function commentsOf(api: (path: string) => any, number: number, count: number) {
  const last = Math.max(1, Math.ceil(count / 100));
  const comments: any[] = [];
  for (let page = Math.max(1, last - 1); page <= last; page++) comments.push(...api(`issues/${number}/comments?per_page=100&page=${page}`));
  return comments.slice(-100).map((c) => ({ body: c.body, createdAt: c.created_at, author: { login: c.user?.login } }));
}

/**
 * The pull requests the row's timeline cross-references, each with the branch its head is (the claim's own check reads `headRefName`), at most five as the GraphQL `closedByPullRequestsReferences(first: 5)` was. A
 * cross-reference names a pull request that mentions the row, which is the population a closing keyword makes too.
 */
function closingPullRequestsOf(api: (path: string, flags?: string[]) => any, number: number) {
  // `--paginate` alone prints one JSON array per page back to back, which is not JSON once the timeline has a second page; `--slurp` makes it one array of pages
  const events: any[] = (api(`issues/${number}/timeline`, ["--paginate", "--slurp"]) as any[][]).flat();
  const pulls = new Map<number, { number: number; title: string }>();
  for (const event of events) {
    if (event.event === "cross-referenced" && event.source?.issue?.pull_request) pulls.set(event.source.issue.number, { number: event.source.issue.number, title: event.source.issue.title });
  }
  return [...pulls.values()].slice(0, 5).map((pr) => ({ number: pr.number, headRefName: api(`pulls/${pr.number}`).head.ref, title: pr.title }));
}

/**
 * The rows among `numbers` that are CLOSED and still carry `claimLabel`, over REST (the GraphQL pool can run dry while REST's does not): each with its labels, the comments the claim record is read from and the pull
 * requests that cross-reference it. `aim` is the repository the calls are aimed at when it is not the executor's own. THROWS when a read is refused or an answer is not JSON; a row `gh` answers 404 for is absent.
 */
export function closedClaimedRowsOf({ repo, aim, numbers, claimLabel, run }: { repo: string; aim?: string; numbers: number[]; claimLabel: string; run: AimedRun }): ClosedClaimedRead[] {
  const api = (path: string, flags: string[] = []) => json(run(["api", ...flags, `repos/${repo}/${path}`], aim));
  const rows: ClosedClaimedRead[] = [];
  for (const number of numbers) {
    const issue = absentIsNull(() => api(`issues/${number}`));
    if (issue === null || issue.state !== "closed" || !issue.labels.some((l: { name: string }) => l.name === claimLabel)) continue;
    rows.push({ number, labels: issue.labels, comments: commentsOf(api, number, issue.comments), closedByPullRequestsReferences: closingPullRequestsOf(api, number) });
  }
  return rows;
}

/** How many CLOSED rows of one kind each answer label is read for, newest update first (see the gate's note on the 500,000-node ceiling). */
const CLOSED_ANSWER_ROWS_PER_LABEL = 100;

/** The labels read from each such row: enough to find the answer label among a row's own, and fewer than a row's usual so many answer labels fit one request. */
const ANSWER_ROW_LABELS = "labels(first:30){nodes{name}}";

/**
 * #5050: THE CLOSED ISSUES (or the closed and merged pull requests) CARRYING ANY OF THE NAMED LABELS, as ONE aliased GraphQL read -- `repository { a0: issues(labels:["answer:x"], states:CLOSED) ... }`, a connection,
 * where `issue list --search 'label:"answer:x","answer:y"'` was a SEARCH. A search's `label:a,b` is OR and a connection's `labels:[a,b]` is AND, hence one alias per label and a row carrying two of them read twice and kept once.
 *
 * Under the tick's refusal memory: a limit another read met is not answered by asking again. Answers the rows in the shape `gh` gave (`labels` an array); `null` when the answer is not whole (`errors` beside `data` is
 * refused too); a throw is the caller's `catch`, which names the refused call.
 */
export function closedRowsCarryingLabels({ names, kind, run }: { names: string[]; kind: "issues" | "pullRequests"; run: RowsRun }, pool: RowsReadHelpers["pool"]): ClosedLabelledRow[] | null {
  const states = kind === "issues" ? "CLOSED" : "[CLOSED, MERGED]";
  const extra = kind === "issues" ? "" : " isDraft";
  const aliased = names.map((name, at) => `a${at}: ${kind}(labels: [${JSON.stringify(name)}], states: ${states}, first: ${CLOSED_ANSWER_ROWS_PER_LABEL}, `
    + `orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title state${extra} ${ANSWER_ROW_LABELS} } }`);
  const args = ["api", "graphql", "-f", `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){ ${aliased.join(" ")} }}`, "-F", "owner={owner}", "-F", "name={repo}"];
  const parsed = JSON.parse(readUnlessRefused({ what: `CLOSED ${kind} labelled ${names.length} answer label(s)`, run, pool, read: () => run(args) }));
  const repository = parsed?.errors ? null : parsed?.data?.repository;
  if (repository === null || typeof repository !== "object") return null;
  const connections: any[] = Object.values(repository);
  if (!connections.every((connection) => Array.isArray(connection?.nodes))) return null;
  const seen = new Set<number>();
  return connections.flatMap((connection) => connection.nodes).filter((row: any) => !seen.has(row.number) && seen.add(row.number))
    .map((row: any) => ({ ...row, labels: row.labels.nodes }));
}
