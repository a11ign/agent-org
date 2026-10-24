// @ts-check
// module: the code host contract's optional `rows` group, the pullwork section -- row mode's GitHub operations that the last callers of `src/` ask (contract 1.12, A11-160 step 9)
//
// A TYPE FILE: it imports nothing at run time. Each member is a named operation of what a caller asks, never a `gh` command line; it takes the `run` its caller hands it where the caller keeps its own executor, and
// THROWS (or answers `null` where its name says so) when the read is refused: none returns an empty list for "could not ask".
//
// The callers of this section: `pr-open` (opens or edits a pull request, arms it and labels it with its owner, and reads the facts its refusals decide on), `pr-hold` (takes or releases a hold, the labels and the
// auto-merge it reads and writes), `carry-branch` (leaves its note on the branch's pull request), `stranded-branches` (the pull requests of every branch, and the lifetime sweep that closes the stale ones), the
// worker's `Stop` hook (the pull requests of a claimed row's repository). Each of them keeps its policy: HOW the program is run is
// the runner it asks the code host for (`runnerWith`), and what it DECIDES from an answer is its own.
//
// The first four members build argument lists, and take no `run`: `pr-open` hands them to its own executor (the one that gives `gh` the terminal and the variables the gate's wrapper reads), because the wrapper may HOLD a
// create for a rate limit, and the arm and the label that follow it are then written down, as argument lists, to travel with the held call and be made after it. Core keeps no argument list of its own: it asks for the
// steps, and runs or files what it is given.
import type { RowsRun } from "./code-host-rows.ts";

/** The head of a pull request: the branch it was opened from and the commit it is at. */
export type PullHead = { ref: string; oid: string };

/** The login `gh` authors a pull request as, or why none of the reads that can say answered: one reason per read, in the order they were tried. */
export type AuthoringLogin = { login: string } | { failures: string[] };

/** What a pull request's auto-merge reads as: `autoMergeRequest` is `null` when it is not armed (or has merged), and `state` is GitHub's word for the pull request. */
export type AutoMergeRead = { autoMergeRequest?: unknown; state?: unknown };

/**
 * The row a hold waits on, as the hold reads it: its state, the names of its labels, the open pull requests that GitHub resolves as closing it, and the row itself (its body and comments, for the waits it declares).
 * `closedByPullRequestsReferences` lists a pull request that is open or MERGED, and a merged one has closed the row, so on an OPEN row every reference is an open pull request.
 */
export type HoldTargetRead = { state: "open" | "closed"; labels: string[]; openPullRequests: { number: number; repo: string }[]; row: Record<string, any> };

/** One page of the pull requests' head branches, or why the answer is not one: the words the caller refuses in (it is neither a refusal, which throws, nor a page). */
export type HeadRefsPage = { refs: string[] } | { unreadable: string };

/** An open pull request as the lifetime sweep decides on it: GitHub's own fields, as the listing printed them. */
export type SweptPull = { number: number; headRefName: string; createdAt: string; isDraft: boolean; labels: { name: string }[]; mergeStateStatus: string };

export interface RowsPullwork {
  // --- `pr-open` (the arguments of the writes it hands to its own executor) ---
  /** The arguments of the pull request write `mode` (`create` or `edit`) given the arguments `rest` the author passed. */
  pullWriteArgs(mode: string, rest: readonly string[]): string[];
  /**
   * The arm that follows a CREATE, as arguments: auto-merge with a merge commit on the pull request the create made, named by `--head` when it was passed and otherwise by the tree's own `branch` (but only with `--repo`, since
   * GitHub refuses `--repo` with no selector; without it the checkout's own branch is read). `[]` when `--repo` is given and no branch is known, so the step is not sent at all rather than sent in the form GitHub refuses.
   */
  armArgsAfterCreate(request: { rest: readonly string[]; branch: string | null }): string[][];
  /** The label `label` put on the pull request a create made, as arguments, named as {@link armArgsAfterCreate} names it; `[]` when it cannot be. */
  labelArgsAfterCreate(request: { rest: readonly string[]; branch: string | null; label: string }): string[][];
  /** The arguments that make the label `name` with `description` in `repo`, or in the checkout's own repository when `repo` is `null`. */
  labelCreateArgs(request: { name: string; description: string; repo: string | null }): string[];

  // --- `pr-open` (what its refusals read; each takes the runner the caller made with its policy) ---
  /** Whether `repo` (the checkout's own when absent) has the label `name`. A 404 is `false`; any other failure THROWS, because "could not ask" and "absent" are different states. */
  labelExistsForOpening(request: { name: string; repo?: string; run: RowsRun }): boolean;
  /** The head of pull request `number` of `repo`, over REST (the core pool, not the GraphQL one that runs out). THROWS when the read is refused or is not JSON. */
  pullHeadForOpening(request: { repo: string; number: string; run: RowsRun }): PullHead | null;
  /** The body of row `number` of `repo`, over REST, as GitHub printed it. THROWS when the read is refused. */
  rowBodyForOpening(request: { repo: string; number: number; run: RowsRun }): string;
  /** The commit `repo` holds `branch` at; `null` when the repository answers 404 (it holds no such branch). Any other failure THROWS, and is never read as absent. */
  branchHeadForOpening(request: { repo: string; branch: string; run: RowsRun }): string | null;
  /**
   * The login the next pull request is authored as: from `GET /user` and, where that is refused (an installation token answers 403), from the GraphQL viewer. Answers the reasons when neither read says: an empty answer is
   * a failure too, not a login. Never throws for a refused read; what to do with the reasons is the caller's.
   */
  authoringLoginOf(request: { run: RowsRun }): AuthoringLogin;

  // --- `pr-hold` ---
  /** The names of the labels of pull request `number` of `repo`; `null` when the answer could not be had or does not carry a list of named labels (never `[]` for a failure: nobody holds it is the answer that hands out a hold). */
  heldPullLabelsOf(request: { repo: string; number: number; run: RowsRun }): string[] | null;
  /**
   * Adds (`how` is `add`) or takes off (`remove`) `label` on pull request `number`. A refused write THROWS. When `createdWith` (a description) is given and an `add` is refused because the repository has no such label, the label
   * is made with it (forced) and added ONCE MORE: any other failure, and a failed make, is rethrown as it was.
   */
  editHeldPullLabel(request: { repo: string; number: number; label: string; how: "add" | "remove"; createdWith?: string; run: RowsRun }): void;
  /** A pull request's auto-merge request and state, or `null` when the answer could not be had. */
  autoMergeOfHeldPull(request: { repo: string; number: number; run: RowsRun }): AutoMergeRead | null;
  /** A pull request's auto-merge request, aimed at `repo` when it is given (and the checkout's own otherwise). THROWS when the read is refused or is not JSON. */
  autoMergeRequestOfHeldPull(request: { number: number; repo?: string; run: RowsRun }): AutoMergeRead;
  /** Turns auto-merge on, with a merge commit. A refused write THROWS; its exit is not the evidence that it took. */
  armHeldPull(request: { number: number; repo?: string; run: RowsRun }): void;
  /** Turns auto-merge off. A refused write THROWS (it does so when auto-merge was never enabled); its exit is not the evidence that it took. */
  disarmHeldPull(request: { number: number; repo?: string; run: RowsRun }): void;
  /** The row `number` of `repo` that a hold waits on; `null` when it could not be read, is not open or closed, or its labels or closing references are not lists (a pull request number reads `null`). */
  holdTargetRowOf(request: { repo: string; number: number; run: RowsRun }): HoldTargetRead | null;

  // --- `carry-branch` ---
  /** The number of the first open pull request of `branch` in `repo`; `null` when there is none. THROWS when the read is refused or is not JSON. */
  openPullNumberOfBranch(request: { repo: string; branch: string; run: RowsRun }): number | null;

  // --- `stranded-branches` and the worker's `Stop` hook ---
  /** One page (`pageSize` of them, oldest first) of the head branch of every pull request of `repo`, in any state. THROWS when the read is refused; `{ unreadable }` for an answer that is not a list of refs. */
  pullHeadRefsPageOf(request: { repo: string; page: number; pageSize: number; run: RowsRun }): HeadRefsPage;
  /** The newest `limit` open pull requests of the checkout's repository with the fields the sweep decides on. THROWS when the read is refused, is not JSON or is not a list. */
  openPullsForSweep(request: { limit: number; run: RowsRun }): SweptPull[];
  /** Comments on pull request `number` of the checkout's own repository. A refused write THROWS. */
  commentOnCheckoutPull(request: { number: number; body: string; run: RowsRun }): void;
  /** Closes pull request `number` of the checkout's own repository, keeping its branch. A refused write THROWS. */
  closeCheckoutPull(request: { number: number; run: RowsRun }): void;
  /** The newest `limit` pull requests of `repo` in any state with the fields the `Stop` hook decides ownership on. THROWS when the read is refused, is not JSON or is not a list. */
  pullsListedForStop(request: { repo: string; limit: number; run: RowsRun }): Record<string, any>[];
}
