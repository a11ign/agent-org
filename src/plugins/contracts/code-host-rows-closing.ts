// @ts-check
// module: the code host contract's optional `rows` group, the closing section -- row mode's GitHub operations that the last callers of `src/` ask (contract 1.12, A11-160 step 9)
//
// A TYPE FILE: it imports nothing at run time. Each member is a named operation of what a caller asks, never a `gh` command line; it takes the `run` its caller hands it where the caller keeps its own executor, and
// THROWS (or answers `null` where its name says so) when the read is refused: none returns an empty list for "could not ask".
//
// THIS SECTION IS WHAT CLOSES A ROW AND WHAT READS A CLOSED ONE: the two close paths of a merged pull request (`close-rows-for-merged-pr.ts` on the merge, `close-rows-sweep.ts` as the backstop), the verify row they
// file, the board settle's pass over the closed rows (`settle-closed-rows.ts`), the declared-versus-resolved check of a pull request's `Closes` line (`closes-mismatch-check.ts`), the sweep freeze's reads of a claimed
// row's comments (`sweep-window.ts`), the removers of worktrees asking whether a row is still claimed (`worktree-removal.ts`) and `worker:state`'s reads and writes of its row (`worker-state.ts`). A caller's policy (what a
// refusal means, which rows are ours to close) stays in the caller: these answer GitHub's facts in the shapes below.
import type { RowComment } from "../../claim-record.ts";
import type { RowsRun } from "./code-host-rows.ts";

/** A row a pull request declares it closes, as the closing decision weighs it: its state, the names of its labels, and when it was last reopened (`null` if never). */
export type DeclaredRow = { number: number; state: string; labels: string[]; reopenedAt: string | null };

/** A closed row read as a build row: what the verify row is filed from. `milestone` and `parent` are `null` where the row has none. */
export type BuildRowRead = { number: number; title: string; body: string; labels: string[]; milestone: string | null; parent: number | null };

/** The merge facts of a pull request and the rows its closing references name, as the close on the merge reads them. */
export type MergedPullClosing = {
  merged: boolean; baseRefName: string | null; mergedAt: string | null; headRefName: string | null; body: string;
  /** The merge commit, or `null` when GitHub gave none. */
  mergeSha: string | null;
  /** Each closing reference with the repository it is a row of (`null` where GitHub named none). Empty for a pull request that has not merged. */
  closing: (DeclaredRow & { repo: string | null })[];
};

/** The merge facts of a merged pull request and its closing references, each with the build row the verify row is filed from (`null` where the title was not returned: "could not read", never "no reading"). */
export type MergedPullRows = {
  mergedAt: string | null; headRefName: string | null; body: string; mergeSha: string | null;
  rows: (DeclaredRow & { build: BuildRowRead | null })[];
};

/** One open claimed row with the newest comments read of it, and how many comments it has in all. */
export type ClaimedRowComments = { number: number; comments: RowComment[]; commentsTotal: number };

/** The claimed rows of ONE tracker in a page, and how many there are in all: a total beyond the page is a page that is not the population. */
export type ClaimedRowsPage = { total: number; rows: ClaimedRowComments[] };

/** A pull request's head branch, and whether it is a fork's. */
export type PullHeadRead = { branch: string; fork: boolean };

/** One page of the closed rows that sit on a project: their numbers, and where the next page begins. */
export type ClosedRowPage = { numbers: number[]; hasNextPage: boolean; endCursor: string | null };

/** A row as `worker:state` reads it: its state, the names of its labels, its comments (id, address, body, time) and its body. */
export type WorkerStateRow = { state: "OPEN" | "CLOSED"; labels: string[]; comments: { id: string; url: string; body: string; createdAt: string }[]; body: string };

export interface RowsClosing {
  /**
   * The text of one minimal GraphQL call with its response headers, which the close paths read the rate limit off (`rateLimitHeaders`): the headers of a real response, not the rate-limit endpoint's body. THROWS
   * when the call is refused; the caller prints that and goes on, as a reading that fails to print must not take the sweep down. From `close-rows-for-merged-pr.ts`'s `logRateLimit`.
   */
  rateLimitDumpOf(request: { run?: RowsRun }): string;
  /** Closes a row as COMPLETED with a comment, in one act. THROWS when refused: the caller reports the row as not closed. From `close-rows-for-merged-pr.ts` and `close-rows-sweep.ts`. */
  closeCompletedRow(request: { repo: string; row: number; comment: string; run?: RowsRun }): void;
  /** A row's number, state and the names of its labels. THROWS when the read is refused. From `close-rows-for-merged-pr.ts`'s orphaned-row lookup. */
  rowNumberStateAndLabelsOf(request: { repo: string; number: number; run?: RowsRun }): { number: number; state: string; labels: string[] };
  /** A row's state and the names of its labels. THROWS when the read is refused. From `worktree-removal.ts`'s claim read. */
  rowStateAndLabelsOf(request: { repo: string; number: number; run?: RowsRun }): { state: string; labels: string[] };
  /** A row's comments as GitHub lists them, oldest first; none when it has none. THROWS when the read is refused. From `sweep-window.ts`. */
  commentsOfRowIn(request: { repo: string; number: number; run?: RowsRun }): RowComment[];
  /**
   * A row a merged pull request's body or `Closes: none` declares, in its repository: state, labels and when it was last reopened. `null` when the number is no issue there (a pull request's number, a typo).
   * THROWS when the read is refused. From `close-rows-for-merged-pr.ts`'s `liveLookupDeclaredRow`.
   */
  declaredRowOf(request: { repo: string; number: number; run?: RowsRun }): DeclaredRow | null;
  /**
   * {@link declaredRowOf} with the fields of its build row, for the sweep: the row, and its build (`null` where the title was not returned). `null` when the number is no issue there. THROWS when the read is refused.
   * From `close-rows-sweep.ts`'s `Closes: none` lookup.
   */
  declaredBuildRowOf(request: { repo: string; number: number; run?: RowsRun }): { row: DeclaredRow; build: BuildRowRead | null } | null;
  /** A closed row read as a build row (title, body, labels, milestone, parent). `null` when it is no issue there. THROWS when the read is refused. From `close-rows-for-merged-pr.ts`'s `liveReadBuildRow`. */
  buildRowOf(request: { repo: string; number: number; run?: RowsRun }): BuildRowRead | null;
  /** The merge facts of pull request `number` of `repo` and the rows its closing references name. THROWS when the read is refused. From `close-rows-for-merged-pr.ts`'s `readClosingReferences`. */
  mergedPullClosingOf(request: { repo: string; number: string; run?: RowsRun }): MergedPullClosing;
  /** {@link mergedPullClosingOf} for the sweep, which also carries each referenced row's build row. THROWS when the read is refused. From `close-rows-sweep.ts`'s `readClosingRows`. */
  closingRowsOfMergedPull(request: { repo: string; number: number; run?: RowsRun }): MergedPullRows;
  /**
   * Files a row with labels and, where one is named, a milestone, and answers its number. THROWS when the call is refused, and when it printed no address to number the row by: a row filed and not numbered would be
   * filed again. From `close-rows-for-merged-pr.ts`'s verify row.
   */
  fileRowInMilestone(request: { repo: string; title: string; body: string; labels: readonly string[]; milestone: string | null; run?: RowsRun }): number;
  /** Makes row `blocker` a blocker of row `row`. THROWS when refused. From `close-rows-for-merged-pr.ts`'s verify row. */
  addBlockedByEdge(request: { repo: string; row: number; blocker: number; run?: RowsRun }): void;
  /** Makes row `child` a sub-issue of row `parent`. THROWS when refused. From `close-rows-for-merged-pr.ts`'s verify row. */
  addSubIssueTo(request: { repo: string; parent: number; child: number; run?: RowsRun }): void;
  /**
   * One page of the CLOSED rows of `owner/name` that sit on project `projectNumber` (each row's own membership is read, because the connection carries no project qualifier). THROWS when the read is refused, and on every
   * shape it does not recognise, including a row whose membership came back shorter than its total with none of the fetched entries naming the project: this list is what tells a complete board read from a partial one,
   * so a list it had to guess at would make the floor report clean. From `settle-closed-rows.ts`.
   */
  closedRowPageOf(request: { owner: string; name: string; after: string | null; projectNumber: number; run?: RowsRun }): ClosedRowPage;
  /**
   * The open rows of `repo` that carry `label`, `count` of them at most, each with its newest `window` comments; `total` is how many such rows there are. THROWS when the read is refused. From `closes-mismatch-check.ts`'s
   * `lookupOpenClaimedRows`.
   */
  claimedRowsWithComments(request: { repo: string; label: string; count: number; window: number; run?: RowsRun }): ClaimedRowsPage;
  /** A pull request's head branch and whether it is a fork's. THROWS when the read is refused, and when it names no head branch. From `closes-mismatch-check.ts`'s `lookupPrHead`. */
  headBranchAndForkOf(request: { repo: string; number: number; run?: RowsRun }): PullHeadRead;
  /** The text of one file of `repo`, raw, as its default branch holds it or (with `ref`) as that commit does. THROWS when the read is refused. From `closes-mismatch-check.ts`'s `lookupConsumerFile`. */
  consumerFileTextOf(request: { repo: string; path: string; ref?: string; run?: RowsRun }): string;
  /**
   * A row as `worker:state` weighs it, in one call. `null` when GitHub says there is no such issue; THROWS on any other refusal, and when the answer carries no comments (no comments would read as no ruling). From
   * `worker-state.ts`'s `ghRowLook`.
   */
  rowWithCommentsOf(request: { repo: string; number: number; run?: RowsRun }): WorkerStateRow | null;
}
