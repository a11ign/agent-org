// @ts-check
// module: the code host contract's optional `rows` group, the classes section -- row mode's GitHub operations that the last callers of `src/` ask (contract 1.12, A11-160 step 9)
//
// A TYPE FILE: it imports nothing at run time. Each member is a named operation of what a caller asks, never a `gh` command line; it takes the `run` its caller hands it where the caller keeps its own executor, and
// THROWS (or answers `null` where its name says so) when the read is refused: none returns an empty list for "could not ask".
//
// THE CALLERS OF THIS SECTION: `ci-failure-class.ts` (the facts of a red check, the shared-failure incident row, the refresh of the pull requests a merged fix owes), `class-repeat.ts` (the closed rows that carry a
// `class:` label), `provider-low-confidence.ts` (the rows of one class), `hand-fix-ledger.ts` (who authored `main`'s commits and its merged pull requests), `decision-confidence-post.ts` and `route-guard.ts` (the day's comment on the tracker
// epic), `tracker-comment.ts` (a tracker comment read safely; it is replaced by `editComment`), `fleet-gated-nightly.ts` (the open rows that carry the fleet-gated label) and `host-kernel.ts` (a comment on a row of the repository a
// checkout belongs to, the body on standard input). `commentOnRowByInput` (step 8) names the repository in the argument list; this one aims the program by the directory it runs in, so it is its own operation.
import type { RowsRun } from "./code-host-rows.ts";

/** What a red check of a pull request's head says, read to the end: the branch the pull request is from, the workflow run the check belongs to (its name and which attempt it is) and the check job's whole log, escapes included. */
export type RedCheckRead = Readonly<{ branch: string; workflow: string; runAttempt: number; log: string }>;

/** Which workflow runs {@link RowsClasses.recentRunsOf} lists: the newest runs on `main`, or the newest runs that failed for a pull request. */
export type RecentRunsKind = "on-main" | "failing-for-pull-requests";

/** A workflow run as the CI facts read it; a member the code host did not state is absent. */
export type RecentRunRead = Readonly<{ name?: string; conclusion?: string | null; headBranch?: string; updatedAt?: string }>;

/** An incident row of a shared CI failure: its number and body, when it was created and closed (as the code host states them), its labels, and the pull requests that closed it (each with the repository it is in, `owner/name`). */
export type SharedFailureRowRead = Readonly<{
  number: number; body: string; createdAt?: string; closedAt?: string; labels: string[];
  closedBy: { number: number; repo?: string }[];
}>;

/** A closed row that is not a pull request, as the class-repeat fact reads it: when it closed (epoch ms, `null` where the code host states no time) and the names of its labels. */
export type ClosedClassRowRead = Readonly<{ number: number; title: string; closedAt: number | null; labels: string[] }>;

/** A closed row as the labelling of unclassed incidents reads it: its number, title and the names of its labels. */
export type ClosedRowTitled = Readonly<{ number: number; title: string; labels: string[] }>;

/** A row of one label, in either state: its number, title, state word and close time as the code host states them. */
export type LabelledRowRead = Readonly<{ number: number; title: string; state: string; closedAt: string | null }>;

/** A merged pull request as the hand-fix ledger reads it: its number, its author's login (`null` where the code host names none), its title and its body. */
export type MergedPullRead = Readonly<{ number: number; author: string | null; title: string; body: string }>;

/** A commit of `main` and the login that authored it, `null` where the code host matches the author to no account. */
export type CommitLoginRead = Readonly<{ sha: string; login: string | null }>;

/** What posting a marked comment once came to: it was already there, or it was posted and this is the reference GitHub printed for it. */
export type MarkedPost = { posted: false } | { posted: true; ref: string };

/**
 * What a tracker comment answers when it is read for an edit. `body` is a comment (its text, possibly empty: an emptied comment still exists). The other two are answers that are NOT a comment, and a caller refuses to
 * treat them as one: `not-json` (`head` is the first 200 characters of what came back) and `not-a-comment` (`said` is the code host's own message when the answer carries one, `got` the first 200 characters of the answer).
 */
export type CommentBodyRead =
  | Readonly<{ kind: "body"; body: string }>
  | Readonly<{ kind: "not-json"; head: string }>
  | Readonly<{ kind: "not-a-comment"; said: string | null; got: string }>;

/** An open row that carries a label, as the nightly fleet-gated firing reads it: its number and its comments (the code host's own list, unread by the firing). */
export type LabelledOpenRow = Readonly<{ number: number; comments: unknown[] }>;

export interface RowsClasses {
  // --- ci-failure-class.ts: the facts of one red check ---
  /**
   * The facts of the red check of pull request `number` of `repo` whose head starts with `head8`: the branch, the workflow run the check belongs to and the check job's log. The check read is the first failing check that
   * is not the roll-up `gate`, else the first failing one. `null` when the head is no longer the one named, when nothing is red, or when the red check is not a workflow job. THROWS when a read is refused or is not
   * the shape asked for: a caller turns that into "could not determine", never into "not red".
   */
  redCheckOf(request: { repo: string; number: number; head8: string; run: RowsRun }): RedCheckRead | null;
  /** The newest `limit` workflow runs of `repo` of the kind asked. THROWS when the read is refused or is not JSON; an answer that carries no list is the empty list. */
  recentRunsOf(request: { repo: string; kind: RecentRunsKind; limit: number; run: RowsRun }): RecentRunRead[];
  /** The repository and the job id a check's details address names, or `null` when it names no workflow job. PURE: it asks the code host nothing. */
  jobOfCheckUrl(detailsUrl: string): { repo: string; jobId: string } | null;
  /** The name of the first failed step of job `jobId`, or `null` when the job has none. THROWS when the read is refused or is not JSON. */
  jobFailedStepOf(request: { repo: string; jobId: string | number; run: RowsRun }): string | null;
  /** The log of job `jobId` as text, the runner's colour codes among it. THROWS when the read is refused. */
  jobLogTextOf(request: { repo: string; jobId: string | number; run: RowsRun }): string;
  /** The names of the files pull request `number` of `repo` changes, the first `perPage` only; `null` when the answer is not a list. THROWS when the read is refused or is not JSON. */
  changedFilesPageOf(request: { repo: string; number: number; perPage: number; run: RowsRun }): string[] | null;
  /** When pull request `number` of `repo` merged, as the code host states it, or `null` when it has not. THROWS when the read is refused or is not JSON. */
  pullMergedAtOf(request: { repo: string; number: number; run: RowsRun }): string | null;
  /** How many commits of its base the head of pull request `number` of `repo` does not contain; `null` when the pull request is not open. THROWS when a read is refused or is not JSON. */
  openPullBehindBy(request: { repo: string; number: number; run: RowsRun }): number | null;
  /** Updates the branch of pull request `number` of `repo` from its base. A refusal (a conflict) THROWS. */
  updatePullBranch(request: { repo: string; number: number; run: RowsRun }): void;

  // --- ci-failure-class.ts: the incident row of a failure shared by several pull requests ---
  /** The newest `newest` rows of the home tracker that carry `label` and are in `state`, with what the refresh of a merged fix reads. THROWS when the read is refused, so a tick that could not list them never files a second row. */
  sharedFailureRowsOf(request: { label: string; state: "open" | "closed"; newest: number; run: RowsRun }): SharedFailureRowRead[];
  /** Creates `label` (or updates its description) and files a row with `title` and `body` carrying it, in the repository the call is aimed at. Answers the new row's number, or `null` when the code host's answer names none. THROWS when either write is refused. */
  fileSharedFailureRow(request: { label: string; description: string; title: string; body: string; run: RowsRun }): number | null;

  // --- class-repeat.ts: the closed rows that carry a class label ---
  /** The newest-updated `perPage` closed rows of `repo` that are not pull requests, those that carry `classLabel` only when one is named; `null` for an answer that is not such a listing. THROWS when the read is refused. */
  closedClassRowsOf(request: { repo: string; classLabel: string | null; perPage: number; run: RowsRun }): ClosedClassRowRead[] | null;
  /** The newest-updated `perPage` closed rows of `repo` that are not pull requests, with their titles; `null` for an answer that is not such a listing. THROWS when the read is refused or is not JSON. */
  closedRowsTitledOf(request: { repo: string; perPage: number; run: RowsRun }): ClosedRowTitled[] | null;
  /** The rows of `repo` that carry `label`, in both states, the open ones first. THROWS when the read is refused or is not a list, so a caller never takes a listing that could not be read for one with no row in it. */
  labelledRowsOf(request: { repo: string; label: string; run: RowsRun }): LabelledRowRead[];

  // --- hand-fix-ledger.ts: who authored what on `main` ---
  /** Every commit of `main` in `repo` since `since`, every page, with the login that authored it. THROWS when the read is refused. */
  mainCommitLoginsSince(request: { repo: string; since: Date; run: RowsRun }): CommitLoginRead[];
  /** The pull requests of `repo` merged since `since` (a window of at most `maxPages` pages), with author, title and body. THROWS when the read is refused or the window is longer than its pages. */
  mergedPullsSince(request: { repo: string; since: Date; maxPages: number; run: RowsRun }): MergedPullRead[];

  // --- decision-confidence-post.ts and route-guard.ts: the day's comment on the tracker epic ---
  /**
   * Posts `text` under `marker` as a comment on row `issue` of `repo`, once: when a comment of that row since `day` (a UTC date) already opens with the marker nothing is posted. THROWS when either call is refused, and a
   * post that could not tell whether the day's comment is there must not guess.
   */
  postMarkedIssueComment(request: { repo: string; issue: number; marker: string; day: string; text: string; run: RowsRun }): MarkedPost;

  // --- tracker-comment.ts: a tracker comment read safely (#563); it is replaced by the base `editComment` ---
  /** Reads comment `id` of `repo`. THROWS when the read is refused, with the error the run threw (its `stdout` holds the code host's error document, which names the cause); an answer that is not a comment is returned as such, NEVER as a body. */
  commentBodyOf(request: { repo: string; id: number; run: RowsRun }): CommentBodyRead;

  // --- host-kernel.ts ---
  /**
   * Comments on row `number` of the repository the checkout `cwd` belongs to, with `body` handed over on standard input and not in an argument list. The code host starts the program itself, in `cwd`, cut at
   * `timeoutMs`. THROWS when the program fails, with what it printed (or why it could not start).
   */
  commentOnCheckoutRowByInput(request: { number: string | number; body: string; cwd: string; timeoutMs: number }): void;

  // --- fleet-gated-nightly.ts ---
  /** The open rows of `repo` that carry `label`, at most `limit` of them, with their comments. THROWS when the read is refused or is not JSON; a caller refuses a listing that fills `limit`, which may be cut short. */
  openRowsCarryingLabel(request: { repo: string; label: string; limit: number; run: RowsRun }): LabelledOpenRow[];
}
