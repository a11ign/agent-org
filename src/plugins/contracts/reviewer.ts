// @ts-check
// module: the reviewer contract, version 1.0 -- `ReviewerPort`, moved as it was, with the two calls the pool makes before it starts one (A11-158)
//
// A TYPE FILE: it imports nothing at run time. The atomic reviewer (`ticket-mode/reviewer-port.ts`) implements it; `reviewer-port.ts` re-exports these types,
// so no caller changed when the contract moved.

/** The reviewer contract's version, `<major>.<minor>`: a minor only adds, and a major breaks (`src/plugins/version.ts`). */
export const REVIEWER_CONTRACT_VERSION = "1.0";

/** A pull request at one head: its url, and the commit the reviewer reads and the verdict is on. */
export type ReviewerRef = Readonly<{ pr: string; head: string }>;

/**
 * The port: start a reviewer for a ready pull request at its head, or refuse naming why; say whether one is live for that head; close it once its
 * verdict is posted; retire a pull request's reviewer once it has merged or closed; and list the pull requests whose reviewer workspaces the session holds.
 */
export type ReviewerPort = Readonly<{
  /** Starts a reviewer, once the head is claimed for this instance. `tookOver` says which expired claim was taken over, when one was (A11-149). */
  start(ref: ReviewerRef): Readonly<{ label: string; tookOver?: string }> | Readonly<{ refusal: string }>;
  live(ref: ReviewerRef): boolean;
  close(ref: ReviewerRef): CloseAnswer;
  retire(pr: string): RetireAnswer;
  listedPulls(): readonly string[];
  /** Whether the reviewer for `ref` is still working, has ended its turn, or is not there (A11-83). */
  settled(ref: ReviewerRef): ReviewerSettled;
  /** The verdict file the reviewer wrote for `ref` in its checkout, or null when it wrote none (A11-83). */
  verdictFileOf(ref: ReviewerRef): string | null;
  /** Posts a verdict file through the verdict door for `ref`, minting the reviewer's token first (A11-83). */
  repostVerdict(ref: ReviewerRef, file: string): RepostAnswer;
  /** Sends the reviewer its verdict prompt again, for a reviewer that ended without writing a verdict file (A11-83). */
  reprompt(ref: ReviewerRef): PromptAnswer;
}>;

/** Where a reviewer stands: `working` while its turn runs, `ended` when it has finished its turn (or its agent has exited), `gone` when herdr lists none for its head. */
export type ReviewerSettled = "working" | "ended" | "gone";

/**
 * What `repostVerdict` answers: `posted`, or a refusal naming why the verdict is not on the pull request. `final` is set where a later attempt would
 * only be refused the same way (the door's exits for a malformed call, a second review at an equal patch, and a moved head); the pool stops there.
 */
export type RepostAnswer = Readonly<{ posted: true }> | Readonly<{ refusal: string; final: boolean }>;
/** What `reprompt` answers: `prompted`, or a refusal naming why the prompt was not sent. */
export type PromptAnswer = Readonly<{ prompted: true }> | Readonly<{ refusal: string }>;

/**
 * What `close` answers: `closed` (the workspace under the seat's label is closed), `gone` (herdr lists none: nothing to close), or `busy` (one is still
 * working: asked again), or a refusal naming why.
 */
export type CloseAnswer = Readonly<{ state: "closed" | "gone" | "busy" }> | Readonly<{ refusal: string }>;
/**
 * What `retire` answers: `retired`, with the report of the uncommitted changes its checkout is removed with (null when it had none, or none could be
 * seen), or a refusal naming the step that did not happen. A refusal leaves whatever is not yet removed in place for the next sweep.
 */
export type RetireAnswer = Readonly<{ retired: true; report: string | null }> | Readonly<{ refusal: string }>;


/**
 * A reviewer plugin: the port the pool holds, and the two calls before it. `load` prepares whatever the reviewer needs on this host and keeps a refusal rather
 * than throwing it (today `loadReviewerGate`); `refusal` says why the reviewer cannot start here, or is null when it can (today `reviewerRefusal`), and
 * needs `load` first.
 */
export type Reviewer = ReviewerPort & Readonly<{
  load(): Promise<void>;
  refusal(): string | null;
}>;
