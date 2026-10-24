// @ts-check
// module: the code host contract's optional `rows` group, the queue section -- row mode's GitHub operations that the queue table, the stalled-queue report, the org watch, the red-trunk reading and the trunk sweep ask (contract 1.12, A11-160 step 9)
//
// A TYPE FILE: it imports nothing at run time. Each member is a named operation of what a caller asks, never a `gh` command line; it takes the `run` its caller hands it where the caller keeps its own executor (the queue table
// meters every call it makes, the trunk reading is handed the work gate's executor for the repositories beside the primary), and the code host runs `gh` itself when the caller hands none. A read that is refused THROWS, or answers
// `null` where its name says so: none returns an empty list for "could not ask", and a caller reads a refusal as the unknown it is.
//
// THE CALLERS, and what they keep: `src/trunk-sweep.ts` (the interim cover for a tip with no check runs, which DISPATCHES the trunk workflow: a write), `src/queue-stalled.ts` (reports, never acts), `src/org-watch.ts` (the chairman's
// hourly colour of `main`), `src/trunk-red.ts` (the red-trunk reading the work gate orders a fix from) and `src/queue-table.ts` (the table of open pull requests, the trunk, the required contexts and the API budget). What each
// DECIDES with an answer (a 404 on the runs read is "no such workflow", a pool it could not read is `null`, a count that is not a number is not zero) stays in core.
import type { Pool } from "../../api-pool.ts";
import type { At, RowsRun } from "./code-host-rows.ts";

/**
 * An open pull request as the table of the queue reads it off the pull request listing. `auto_merge` keeps REST's own name and is whatever the listing carried (an object when auto-merge is requested, `null` when it is not):
 * `armedState` is the one place that reads it, beside the queue reading of {@link PullQueueNode}.
 */
export type OpenPullRow = Readonly<{
  number: number;
  /** The branch the pull request is from, or `?` for a listing that names none. */
  headRefName: string;
  /** The commit at its head, or `""` for a listing that names none. */
  headRefOid: string;
  updatedAt: string;
  /** Whether it is a draft; `null` when the listing carried no such flag (absent is never "not a draft"). */
  draft: boolean | null;
  /** The names of its labels. */
  labels: readonly string[];
  auto_merge: unknown;
}>;

/** One open pull request's reading by the merge queue: the auto-merge request and the queue seat GraphQL gives it, under GraphQL's own names. */
export type PullQueueNode = Readonly<{
  number: number;
  autoMergeRequest?: unknown;
  mergeQueueEntry?: Readonly<{ state?: string; position?: number }> | null;
}>;

/** One check run of a commit: its name, its conclusion (lower case, `null` while it runs) and when it completed. */
export type CheckRunBrief = Readonly<{ name: string; conclusion: string | null; completedAt?: string | null }>;

/** The merged pull request GitHub associates with a commit: its number, title and the names of its labels. */
export type OriginPull = Readonly<{ number: number; title: string; labels: readonly string[] }>;

/** What is left in the two pools the table spends, each read from the headers of a real call, or `null` for a pool that could not be read. */
export type ApiBudgetReading = Readonly<{ core: Pool | null; graphql: Pool | null }>;

export interface RowsQueue {
  // --- the trunk sweep (`src/trunk-sweep.ts`, #417) and the queue table's trunk line (`src/queue-table.ts`) ---
  /** The sha of the tip of `main`, trimmed. THROWS when the read is refused. Also `hand-fix-ledger.ts`'s live head of `main`. */
  mainShaOf(request: At<{ repo: string }>): string;
  /** How many check runs commit `sha` carries, as the number GitHub states (`NaN` for an answer that is not one: the caller decides what that means). THROWS when the read is refused. */
  checkRunTotalOf(request: At<{ repo: string; sha: string }>): number;
  /** Dispatches `workflow` (a file name, `trunk.yml`) on the repository's default branch. A WRITE: THROWS when the dispatch is refused, and a caller that is told it did not happen must not assume it did. */
  dispatchWorkflow(request: At<{ repo: string; workflow: string }>): void;
  /** The newest `limit` runs of `workflow` in the repository the working directory is in (no repository is named): `{ headSha, conclusion, status, databaseId }` of each. `null` for an answer that is not a list. THROWS when the read is refused. */
  checkoutWorkflowRunsOf(request: At<{ workflow: string; limit: number }>): any[] | null;

  // --- the stalled-queue report (`src/queue-stalled.ts`) ---
  /** The open pull requests of `repo` against `main`, the newest hundred, with `number`, `headRefOid`, `autoMergeRequest`, `statusCheckRollup` and `isDraft` of each, as the listing answers them. THROWS when the read is refused or is not JSON. */
  openMainPullRollupsOf(request: At<{ repo: string }>): any[];

  // --- the org watch (`src/org-watch.ts`) ---
  /** The newest `perPage` runs of the workflow file `workflow` (`trunk.yml`) on `main`, newest first, as the runs listing answers them; none where the answer carries no list. THROWS when the read is refused or is not JSON. */
  workflowRunsOnMain(request: At<{ repo: string; workflow: string; perPage: number }>): any[];

  // --- the red-trunk reading (`src/trunk-red.ts`, #3079). The reads beside them are `jobsOfRun` and `failedLogOfRun`. ---
  /**
   * The runs of `workflow` on `main` for one `event=<name>` filter (`null` asks none, the primary's `trunk.yml` runs on `main` only), the newest ten: the run list the answer carries, or `null` when the answer carries none
   * (the workflow exists, or the answer is not about a workflow). THROWS when the read is refused, and with what `gh` printed on stderr, so a caller can tell a 404 (no such workflow) from a 403, a 5xx or a timeout; an answer
   * of JSON `null` is a refused read.
   */
  trunkRunsOf(request: At<{ repo: string; workflow: string; eventFilter: string | null }>): any[] | null;
  /** The annotations of check run `checkRunId` (an Actions job id is its check-run id); `null` for an answer that is not a list. THROWS when the read is refused or is not JSON. */
  annotationsOfCheckRun(request: At<{ repo: string; checkRunId: number | string }>): any[] | null;
  /** The first pull request GitHub associates with commit `sha`, never one parsed out of a merge message; `null` when it has none or the answer is not a list. THROWS when the read is refused or is not JSON. */
  originPullOfCommit(request: At<{ repo: string; sha: string }>): OriginPull | null;

  // --- the queue table (`src/queue-table.ts`) ---
  /** The open pull requests of `repo`, the first hundred of the listing; `null` for an answer that is not a list. THROWS when the read is refused or is not JSON. */
  openPullRowsOf(request: At<{ repo: string }>): OpenPullRow[] | null;
  /** The queue reading of every open pull request of `repo` in ONE request (the first hundred); `null` for an answer that is not a list. THROWS when the read is refused or is not JSON: an empty list says "nobody is queued" and a refusal must not. */
  pullQueueStatesOf(request: At<{ repo: string }>): PullQueueNode[] | null;
  /** Every check run of commit `sha`, all pages, as `{ name, conclusion, completedAt }` (a line the answer holds that is not JSON is left out). THROWS when the read is refused. */
  checkRunBriefsOf(request: At<{ repo: string; sha: string }>): CheckRunBrief[];
  /**
   * What is left in the core pool and in the GraphQL pool, each read from the response headers of a call of its own kind (`gh api -i`), THE FAILED CALL'S TOO: `run` exits non-zero on the 403 that says a pool is exhausted, and
   * the headers are on that error's `stdout`. `null` for a pool that could not be read, and `null` when neither could. NEVER throws: "could not ask" is `null`, which is not "nothing is left". `run` is the caller's and is REQUIRED.
   */
  apiBudgetOf(request: { repo: string; run: RowsRun }): ApiBudgetReading | null;
}
