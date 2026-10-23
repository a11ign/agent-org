// module: the GitHub reads behind B2's delivery clause -- the pull request that closes a row, the ones that cross-reference it, and the paths one changes (A11-160, step 7; moved from `src/row-claim/own-pr-health-rule.ts`)
//
// The rule DECIDES which pull request counts (the newest closing reference; the newest whose body declares `Delivers:`); GitHub's connections, their paging to the end and the queries are here. A page without
// `pageInfo` THROWS rather than reading as the last one: the one thing a paged read must never do quietly is stop early (#2026).
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { ClosingPullRead, CrossReferencingPull } from "../../../src/plugins/contracts/code-host-rows-facts.ts";

/**
 * #2026: HOW MUCH OF EACH CONNECTION ONE REQUEST CARRIES -- a PAGE SIZE, not a window. GitHub caps a connection page at 100, and both reads below page to the END rather than stopping at the first page.
 *
 * THE WINDOW THIS REPLACED WAS A SILENT WRONG ANSWER IN BOTH DIRECTIONS: `timelineItems(last:20)` drops a real delivery the moment twenty cross-references accumulate after it -- and a row that is BLOCKING
 * ITS AUTHOR collects them, because every sibling row and pull request that cites the refusal adds one -- while `files(first:100)` misses a Region path that falls after the hundredth changed file of a wide
 * rename. Each truncation reads as "nobody declared a delivery", which leaves the author in build with no way to tell a missing line from an unread one. A cap NOBODY CAN SEE is the defect; a page size
 * everything pages past is not.
 */
const PAGE_SIZE = 100;

/**
 * #2026: THE MOST PAGES EITHER READ WILL TAKE, and it exists to bound a SERVER that never says it has finished -- a `hasNextPage` that stays true against a cursor that stops moving would otherwise spin
 * forever inside a claim. It is not a window: exceeding it THROWS, so the caller's lookup reads `null` and the row stays IN BUILD, which is that clause's own safe direction. `MAX_PAGES * PAGE_SIZE`
 * cross-references or changed files is orders past anything this repository has produced, so reaching it means the connection is misbehaving rather than that the row is busy.
 */
const MAX_PAGES = 50;

/** The cross-reference timeline, to its end. */
const CROSS_REFERENCE_QUERY = "query($owner:String!,$name:String!,$number:Int!,$after:String){"
  + "repository(owner:$owner,name:$name){issue(number:$number){"
  + `timelineItems(first:${PAGE_SIZE},after:$after,itemTypes:[CROSS_REFERENCED_EVENT]){`
  + "pageInfo{hasNextPage endCursor}nodes{"
  + "... on CrossReferencedEvent{source{... on PullRequest{number state body}}}}}}}}";

/** ONE pull request's changed paths, to their end. */
const CHANGED_FILES_QUERY = "query($owner:String!,$name:String!,$number:Int!,$after:String){"
  + "repository(owner:$owner,name:$name){pullRequest(number:$number){"
  + `files(first:${PAGE_SIZE},after:$after){pageInfo{hasNextPage endCursor}nodes{path}}}}}`;

/**
 * ONE PAGE of a GraphQL connection. `$after` is DECLARED by both queries but only SENT once there is a cursor: an unsupplied nullable variable is `null`, which is where a connection starts, and `-f after=`
 * would send the empty STRING instead, which is a cursor GitHub rejects.
 */
function graphqlPage({ run, repo }: { run: RowsRun; repo: string }, query: string, number: number, cursor: string | null): any {
  const [owner, name] = repo.split("/");
  const args = ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`];
  if (cursor) args.push("-f", `after=${cursor}`);
  return JSON.parse(run(args));
}

/** EVERY node of a paged connection, in page order, so the LAST node is still the most recent one. */
function everyNodeOf(page: (cursor: string | null) => { nodes?: any[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }): any[] {
  const all: any[] = [];
  let cursor: string | null = null;
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const { nodes, pageInfo } = page(cursor);
    all.push(...(nodes ?? []));
    if (!pageInfo) throw new Error("a connection page carried no `pageInfo`, so its end cannot be read");
    if (!pageInfo.hasNextPage) return all;
    cursor = pageInfo.endCursor ?? null;
  }
  throw new Error(`a connection did not end within ${MAX_PAGES} pages`);
}

/** The pull requests GitHub resolves as closing row `number`, oldest first, resolved server-side (never a `Closes #N` regex over a body). */
export function closingPullsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): ClosingPullRead[] {
  const [owner, name] = repo.split("/");
  const query = "query($owner:String!,$name:String!,$number:Int!){"
    + "repository(owner:$owner,name:$name){issue(number:$number){"
    + "closedByPullRequestsReferences(first:5){nodes{number state headRefOid}}}}}";
  const data = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]));
  return data.data.repository.issue.closedByPullRequestsReferences.nodes;
}

/**
 * EVERY item that cross-references row `number`, read to the end of the timeline. A cross-reference whose source is an ISSUE matches no inline fragment and arrives as `{}`, so a pull request is told apart by its
 * `number`. The timeline asks for no file lists: the files are needed for exactly one pull request ({@link changedPathsOfPull}).
 */
export function crossReferencingPullsOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): CrossReferencingPull[] {
  return everyNodeOf((cursor) => graphqlPage({ run, repo }, CROSS_REFERENCE_QUERY, number, cursor).data.repository.issue.timelineItems)
    .map((node: { source?: object }) => node.source ?? {});
}

/** EVERY path one pull request changes, to the end of its file list: a wide rename runs past a hundred files, and a truncated list would refuse the delivery that proves the point. */
export function changedPathsOfPull({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string[] {
  return everyNodeOf((cursor) => graphqlPage({ run, repo }, CHANGED_FILES_QUERY, number, cursor).data.repository.pullRequest.files)
    .map((file: { path: string }) => file.path);
}
