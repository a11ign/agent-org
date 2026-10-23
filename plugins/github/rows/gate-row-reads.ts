// module: the GitHub reads of ONE ROW's history and facts that the work gate asks (A11-160, step 6; moved from `src/work-gate/`)
//
// The gate DECIDES (which label is a wait, who counts as the chairman, whether a row is answered); what it ASKS OF GITHUB and how it reads the answer is here: a row's label events, its comments, its timeline, the
// state of an item a wait names, an incident issue, and the facts a promotion reads. Each takes the `run` the gate hands it (the contract's head says why: the gate's executor carries the tick's memo, budget and
// call census) and builds the same argument list the gate built, so the memo's keys and the ledger's lines are what they were. Each THROWS when `gh` refuses or an answer is not the shape: "could not read" is never
// an empty list. `{owner}/{repo}` is `gh`'s own placeholder, which it resolves from the repository the call is aimed at.
import type { AimedRun, RowsReadHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import { readUnlessRefused } from "./rows-by-label.ts";

/** The repository a literal path names, or `gh`'s placeholder when the caller names none. */
const placeholderOr = (repo: string | undefined): string => (repo === undefined || repo === "" ? "{owner}/{repo}" : repo);

/** The lines `gh api --jq` printed, one JSON object per line. */
const jsonLines = (out: string): any[] => out.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));

/** The `unlabeled` events of a row, each with the label named and when: `issues/{n}/events`, the cheaper subset of the timeline. */
export function unlabeledEventsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { name: string; at: string }[] {
  return jsonLines(run(["api", `repos/${repo}/issues/${number}/events`, "--paginate", "--jq",
    '.[] | select(.event == "unlabeled") | {name: .label.name, at: .created_at}']));
}

/** When `label` was applied to a row (ISO times, in the order GitHub lists the events: oldest first). `repo` absent is `gh`'s own aim. */
export function labeledEventTimesOf({ repo, number, label, run }: { repo?: string; number: number; label: string; run: RowsRun }): string[] {
  const out = run(["api", `repos/${placeholderOr(repo)}/issues/${number}/events`, "--paginate", "--jq",
    `.[] | select(.event == "labeled" and .label.name == "${label}") | .created_at`]);
  return out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/** The login that applied `label` to a row LAST, or `null` when no event shows one (jq prints `null` for an event whose actor is gone: the newest labeller is then unknown, not an older one's). */
export function newestLabellerOf({ number, label, run }: { number: number; label: string; run: RowsRun }): string | null {
  const out = run(["api", `repos/{owner}/{repo}/issues/${number}/events`, "--paginate", "--jq",
    `.[] | select(.event == "labeled" and .label.name == "${label}") | .actor.login`]);
  const newest = out.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1) ?? null;
  return newest === "null" ? null : newest;
}

/** Each comment of a row as the chairman's check reads it: who wrote it, when, and the first 200 characters of what it said. */
export function commentActivityOf({ number, run }: { number: number; run: RowsRun }): { author: string; at: string; body: string }[] {
  return jsonLines(run(["api", `repos/{owner}/{repo}/issues/${number}/comments`, "--paginate", "--jq",
    ".[] | {author: (.user.login // \"\"), at: .created_at, body: ((.body // \"\") | .[0:200])}"]));
}

/**
 * A row's own `labeled`, `unlabeled` and `commented` timeline events, projected to what the answer checks read -- never the whole payload, which on a long-lived row carries every review, commit and
 * cross-reference too. `actor` is the account that wrote the event and `id` a comment's own id.
 */
export function rowTimelineOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { event: string; label?: { name: string }; actor?: string; id?: number; created_at: string }[] {
  return jsonLines(run(["api", `repos/${repo}/issues/${number}/timeline`, "--paginate", "--jq",
    '.[] | select(.event == "labeled" or .event == "unlabeled" or .event == "commented") | '
    + '{event: .event, label: {name: .label.name}, actor: .actor.login, id: .id, created_at: .created_at}']));
}

/** An item a wait names, as `gh api repos/<r>/issues/<n>` states it for the fields a wait reads (`merged_at` is on a pull request's issue record only). */
export type WaitRefRead = { state?: string; closed_at?: string | null; updated_at?: string | null; merged_at?: string | null; labels?: string[] };

/** The state of an item a wait names. `repo` absent is the repository the call is aimed at. */
export function waitRefOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): WaitRefRead {
  return JSON.parse(run(["api", `repos/${repo}/issues/${number}`, "--jq",
    "{state, closed_at, updated_at, merged_at: .pull_request.merged_at, labels: [.labels[].name]}"]));
}

/** An incident item `ref` (`#889` or `owner/repo#889`) names: whether it is open, its labels and its body. THROWS when it cannot be read: closed and unreadable are different answers. */
export function incidentItemOf({ ref, run }: { ref: string; run: RowsRun }): { open: boolean; labels: string[]; body: string } {
  const [repo, number] = ref.split("#");
  const item = JSON.parse(run(["api", `repos/${placeholderOr(repo)}/issues/${number}`, "--jq", "{state, body, labels: [.labels[].name]}"]));
  return { open: item?.state === "open", labels: Array.isArray(item?.labels) ? item.labels.map(String) : [], body: String(item?.body ?? "") };
}

/** A row's body, read when the list the gate holds did not carry it. */
export function rowBodyOf({ number, run }: { number: number; run: RowsRun }): string {
  return String(JSON.parse(run(["api", `repos/{owner}/{repo}/issues/${number}`, "--jq", "{body}"]))?.body ?? "");
}

/**
 * What the board-truth guard needs of a row, read where the label is written: its state and its NEWEST comment (by anyone), in two REST calls (the issue, then the comments page holding the last one). `null` is a
 * row that could not be read whole, which is unknown and never "open with a question".
 */
export function rowStateAndNewestComment({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { state: string; lastComment: { body: string; createdAt: string } | null } | null {
  try {
    const { state, comments } = JSON.parse(run(["api", `repos/${repo}/issues/${number}`, "--jq", "{state: .state, comments: .comments}"]));
    if (typeof state !== "string" || !Number.isInteger(comments)) return null;
    if (comments === 0) return { state, lastComment: null };
    const page = JSON.parse(run(["api", `repos/${repo}/issues/${number}/comments?per_page=1&page=${comments}`, "--jq", ".[0] | {body: .body, createdAt: .created_at}"]));
    return typeof page?.body === "string" ? { state, lastComment: { body: page.body, createdAt: page.createdAt } } : null;
  } catch {
    return null;
  }
}

/** A row as the promotion reads it: its labels, state, body and blocked-by edges. */
export type RowForPromotion = { labels: string[]; state: string; body: string; blockedBy: { nodes?: { number?: number; state?: string }[] } };

/** The facts a `Ready-when-unblocked` promotion decides on. THROWS when the read is refused. */
export function rowForPromotion({ repo, number, run }: { repo: string; number: number; run: RowsRun }): RowForPromotion {
  const read = JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "labels,state,body,blockedBy"]));
  return { labels: (read.labels ?? []).map((l: any) => String(l.name)), state: String(read.state), body: String(read.body ?? ""), blockedBy: read.blockedBy ?? {} };
}

/** One page of the tracker's issue events, newest first, projected to what the milestone clock reads. Answers GitHub's own parse; the gate refuses what is not a list. */
export function issueEventsPage({ repo, page, pageSize, run }: { repo: string; page: number; pageSize: number; run: RowsRun }): unknown {
  return JSON.parse(run(["api", `repos/${repo}/issues/events?per_page=${pageSize}&page=${page}`, "--jq",
    "[.[] | {at: .created_at, event: .event, label: (.label.name // \"\"), milestone: (.issue.milestone.number // 0), pr: (.issue.pull_request != null)}]"]));
}

/** One page of `repo`'s closed pull requests, most recently updated first, with when each was last updated and closed and its body. */
export function closedPullsPage({ repo, page, pageSize, run }: { repo: string; page: number; pageSize: number; run: RowsRun }): unknown {
  return JSON.parse(run(["api", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`, "--jq",
    "[.[] | {at: .updated_at, closedAt: .closed_at, body: (.body // \"\")}]"]));
}

/** Whether tag `tag` exists on `repo`, or `null` when the read failed. `matching-refs` answers an empty list for an absent tag and matches by prefix, so the exact ref is compared. */
export function tagExistsOn({ repo, tag, run }: { repo: string; tag: string; run: RowsRun }): boolean | null {
  try {
    const refs = JSON.parse(run(["api", `repos/${repo}/git/matching-refs/tags/${tag}`]));
    return Array.isArray(refs) ? refs.some((r) => r?.ref === `refs/tags/${tag}`) : null;
  } catch {
    return null;
  }
}

/** The last `last` comments of each named row of `repo`, in ONE GraphQL call, or `null` when the call was refused or its answer is not whole (`errors` beside `data` is refused too; a row the answer does not carry is left out). */
export function newestCommentsOf({ repo, numbers, last, run }: { repo: string; numbers: number[]; last: number; run: RowsRun }): Map<number, any[]> | null {
  const [owner, name] = repo.split("/");
  const fields = numbers.map((n) => `r${n}: issue(number: ${Number(n)}) { number comments(last: ${last}) { nodes { id body createdAt author { login } } } }`);
  try {
    const parsed = JSON.parse(run(["api", "graphql", "-f", `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
      "-F", `owner=${owner}`, "-F", `name=${name}`]));
    const repository = parsed?.errors ? null : parsed?.data?.repository;
    if (repository === null || typeof repository !== "object") return null;
    const read = Object.values(repository).filter((issue) => Array.isArray((issue as any)?.comments?.nodes));
    return new Map(read.map((issue: any) => [Number(issue.number), issue.comments.nodes]));
  } catch {
    return null;
  }
}

/** The ordered closed rows the blocker backoff reads, as GitHub's connection returns them (`nodes`), or `null` when the answer carries none. */
export type RecentlyClosedNode = { number: number; closedAt: string | null; updatedAt: string | null };

/** The `limit` most recently UPDATED closed rows of the repository the call is aimed at: a connection orders by the field, newest first, where `issue list` ordered by creation. */
export function recentlyClosedRowsOf({ limit, run }: { limit: number; run: AimedRun }, pool: RowsReadHelpers["pool"]): RecentlyClosedNode[] | null {
  const query = "query($owner:String!,$name:String!,$first:Int!){repository(owner:$owner,name:$name){issues(states:CLOSED,first:$first,"
    + "orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number closedAt updatedAt}}}}";
  const args = ["api", "graphql", "-f", `query=${query}`, "-F", "owner={owner}", "-F", "name={repo}", "-F", `first=${limit}`];
  const nodes = JSON.parse(readUnlessRefused({ what: `the ${limit} newest-updated CLOSED rows`, run, pool, read: () => run(args) }))?.data?.repository?.issues?.nodes;
  return Array.isArray(nodes) ? nodes : null;
}
