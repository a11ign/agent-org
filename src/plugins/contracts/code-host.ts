// @ts-check
// module: the code host contract, version 1.1 -- what ticket mode asks of the place pull requests live (A11-158)
//
// A TYPE FILE: it imports nothing at run time. It is SYNCHRONOUS, because every reader of it is: the ticket port's gate (`ticket-port/port.ts`) and ticket
// mode's injected `gh: (args) => string` (`pool-context.ts`). It is written from the GitHub operations ticket mode makes today, and carries `CodeHostPort`'s four
// operations, which stay declared in `port.ts` (its source test holds that file to no import at all, a re-export included) and are named here by a type-only import. It
// imports nothing else of core: `ReviewState` is declared here, and `ticket-mode/reviewer-port.ts` re-exports it.
// An operation joins this contract only when a sibling ticket moves a call that needs it (A11-160 moves the gate's).
//
// ROW MODE'S GITHUB OPERATIONS will join as an optional `rows` group of this contract, not as a second plugin (`docs/adr/0002-row-mode-github-is-an-optional-part-of-the-code-host-contract.md`).
//
// 1.1 (A11-160): `readPullFeedback` takes the accounts whose feedback is not the worker's to answer besides its own (the reviewer's), which ticket mode filtered out of GitHub's
// answer before the read moved into the plugin. A plugin of 1.0 is read as one that is given none.
import type { ChangeFacts, ChangeRef, CodeHostEvent, CodeHostEventKind, CodeHostPort } from "../../ticket-port/port.ts";

export type { ChangeFacts, ChangeRef, CodeHostEvent, CodeHostEventKind, CodeHostPort };

/** The code host contract's version, `<major>.<minor>`: a minor only adds, and a major breaks (`src/plugins/version.ts`). */
export const CODE_HOST_CONTRACT_VERSION = "1.1";

/** A check failing on a pull request's head: its name and the address of the page its run reports (an Actions job's, which names the log to read), or null. */
export type FailingCheck = Readonly<{ name: string; detailsUrl: string | null }>;

/** What the board reads of one pull request. Times are epoch milliseconds, or null when there is none. */
export type PullFeedback = Readonly<{
  state: "open" | "merged" | "closed";
  /** The newest review (commented or changes requested), conversation comment or inline comment by someone other than the board's account. */
  feedbackAt: number | null;
  /** Who left feedback, each once, the author of the newest first. */
  authors: readonly string[];
  /** The checks failing on the head commit, by name: its required ones, or every one where none is required. */
  failing: readonly string[];
  /**
   * Every check failing on the head commit, counted or not, with the address of its job's page (`detailsUrl`), or null for a check that has none, such as a commit status: where its
   * log is read (A11-154). `failing` is the ones the board answers; this also lists a job behind a required roll-up that failed.
   */
  failures: readonly FailingCheck[];
  /** When the newest of those failing checks finished. */
  failedAt: number | null;
  /** Whether it conflicts with its base: GitHub says `CONFLICTING` or `DIRTY`. `UNKNOWN` (still being computed) is not a conflict. */
  conflicting: boolean;
  /** Whether GitHub says it merges cleanly: `MERGEABLE`. `UNKNOWN` (still being computed) is not mergeable, as it is not a conflict either. */
  mergeable: boolean;
  /** The commit its branch is at, or null when GitHub does not say. */
  head: string | null;
  /** Whether the newest approving or changes-requesting review on the head commit, by someone other than the board's account, approves. */
  approvedAtHead: boolean;
  /** The branch it merges into, or null when GitHub does not say. */
  base: string | null;
  /** The files it changes, by path within its repository. */
  files: readonly string[];
  /** Whether `files` is all of them. Read a page of 100 at a time, up to {@link MAX_FILE_PAGES}: a list cut off there is not complete. */
  filesComplete: boolean;
}>;

/** Whether a pull request's author is the org's own (`inside`) or not, which decides how much its reviewer trusts it (`review-trust.ts`). */
export type ReviewTrust = "inside" | "outside";

/**
 * What the pool reads of a pull request's reviewer: its head, whether the org's own, the reviews on it, whether its checks have settled green, and
 * the pull request as the gate's verdict prompt reads it (`view`).
 */
export type ReviewState = Readonly<{ head: string; trust: ReviewTrust; reviews: readonly Review[]; settled: boolean; view: Readonly<Record<string, any>> }>;
export type Review = Readonly<{ author: string; state: string; commit: string; at: number }>;

/** What a stack retarget sweep reads and moves: the open pull requests of a run, the bases it stacked on, and the default branch of each repository. */
export type RetargetRequest = Readonly<{
  urls: readonly string[];
  previous: Readonly<Record<string, string>>;
  /** The branches the run's blockers' pull requests are on: the only bases this run was stacked on, so the only ones a retarget may move. */
  stacked: ReadonlySet<string>;
  /** The default branch of each repository, read once for the sweep (by `owner/repo`). */
  defaults: Map<string, string>;
  log: (line: string) => void;
}>;

/**
 * A code host plugin. Every read answers `null` for "could not ask", never for "there is none": a caller that acts on `null` acts on a guess.
 */
export interface CodeHost extends CodeHostPort {
  /** The login of the account this host acts as, which is the board's workers' own, or null when it cannot be read. */
  readOwnLogin(): string | null;
  /**
   * The feedback on the pull request at `url`, leaving out what `self` wrote and what `alsoIgnore` wrote (the reviewer's, which a worker does not answer and which must never
   * move `feedbackAt`), or null for "could not ask".
   */
  readPullFeedback(url: string, self: string, alsoIgnore?: readonly string[]): PullFeedback | null;
  /** The pull request's state as the reviewer sees it, or null when the host does not say. Throws the reviewer's refusal when its gate does not load. */
  readReviewState(url: string): ReviewState | null;
  /** The pull request's state, `OPEN`, `MERGED` or `CLOSED`, or null when the host does not say. */
  readPullState(url: string): string | null;
  /** The URLs of a repository's open pull requests, or null for "could not ask" (a list at its limit is also null). */
  openPullUrlsOf(repository: string): string[] | null;
  /**
   * The note each open pull request of the sweep needs, by URL, after the retargets that are due are made: a merged base is moved to the default branch, and a
   * base whose branch is gone is said. A pull request that cannot be read keeps the note it had, and its head is never touched.
   */
  sweepRetargets(sweep: RetargetRequest): Record<string, string>;
}
