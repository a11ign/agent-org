// agent-org#893: THE READS AND WRITES OF THE DAILY APPROVED-UNQUEUED READING, as the arguments to `gh` built here and run through an injected `run` (`gh`, as the caller hands it in).
// This file names no `gh` and spawns nothing: `index.test.ts` holds this folder to that, and `gh-call-ratchet.test.ts` is why the arguments are written HERE and not in
// `src/approved-unqueued.ts`, a file outside the plugin. A refused `run` THROWS, and the caller decides what an unread answer is: none of these returns `[]` for a failed read.

import type { KeyedComment, RestReview, RowsRun as Run } from "../../../src/plugins/contracts/code-host-rows.ts";

/**
 * THE COMMENTS OF ROW `row` made since `since` whose body STARTS WITH `marker`: one paginated REST read, so a long row costs one call. `jq` does the filtering, so only the
 * keyed comments come back and each is parsed from one JSON line.
 */
export function keyedCommentsOf({ repo, row, marker, since, run }: { repo: string; row: number; marker: string; since: string; run: Run }): KeyedComment[] {
  const text = run(["api", "--paginate", `repos/${repo}/issues/${row}/comments?per_page=100&since=${since}`,
    "--jq", `.[] | select(.body | startswith(${JSON.stringify(marker)})) | {id, body} | @json`]).trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line));
}

/** Post `body` as a new comment on row `row` of `repo`. */
export function postRowComment({ repo, row, body, run }: { repo: string; row: number; body: string; run: Run }): void {
  run(["issue", "comment", String(row), "--repo", repo, "--body", body]);
}

/**
 * File a new row in `repo` with `labels` and answer its number (agent-org#1208: the tick's standing row, created once). the create prints the row's URL; a print that
 * is not one is thrown, because a row filed and not numbered would be filed again.
 */
export function createRow({ repo, title, labels, body, run }: { repo: string; title: string; labels: string[]; body: string; run: Run }): number {
  const printed = run(["issue", "create", "--repo", repo, "--title", title, ...labels.flatMap((label) => ["--label", label]), "--body", body]).trim();
  const number = /\/issues\/(\d+)\s*$/.exec(printed)?.[1];
  if (number === undefined) throw new Error(`the create printed no row URL: ${printed.slice(0, 120)}`);
  return Number(number);
}

/** Replace the body of the comment `id` of `repo`: the day's reading, edited and never posted a second time. */
export function editComment({ repo, id, body, run }: { repo: string; id: number; body: string; run: Run }): void {
  run(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "-f", `body=${body}`]);
}

/** The reviews of pull request `number`: the fallback for a list payload that carried none. */
export function reviewsOf({ repo, number, run }: { repo: string; number: number; run: Run }): RestReview[] {
  const reviews = JSON.parse(run(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/reviews`]));
  if (!Array.isArray(reviews)) throw new Error("the reviews are not a list");
  return reviews.flat();
}

/**
 * THE MOST RECENTLY UPDATED `window` MERGED PULL REQUESTS of `repo`, each with its approving reviews and its merge-queue entries, in ONE GraphQL read. GraphQL cannot order merged
 * pull requests by `mergedAt`, so the caller sorts by it and keeps its own newest N: `window` is how many are read to find them.
 */
export function mergedWindowOf({ repo, window, run }: { repo: string; window: number; run: Run }): unknown {
  const [owner, name] = repo.split("/");
  const query = "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequests(states:MERGED,first:$n,orderBy:{field:UPDATED_AT,direction:DESC})"
    + "{nodes{number mergedAt reviews(first:50){nodes{state submittedAt}} timelineItems(first:5,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT]){nodes{... on AddedToMergeQueueEvent{createdAt}}}}}}}";
  return JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${window}`, "--jq",
    ".data.repository.pullRequests.nodes | map({number, mergedAt, reviews: .reviews.nodes, queuedAt: [.timelineItems.nodes[].createdAt]})"]));
}

/**
 * The open pull requests of `repo` with the JSON fields `fields` names: the manual run's own list, where the tick passes the one it already holds. The CALLER names the fields,
 * because which of them it reads and what it decides from them is its own (and a module that reads red state answers to `red-pr.ts`, not to a port).
 */
export function openPullsOf({ repo, fields, run }: { repo: string; fields: string; run: Run }): unknown {
  return JSON.parse(run(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", fields]));
}
