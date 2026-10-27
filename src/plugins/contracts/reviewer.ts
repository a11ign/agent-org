// @ts-check
// module: the reviewer contract, version 1.11 -- `ReviewerPort`, moved as it was, with the two calls the pool makes before it starts one (A11-158)
//
// 1.11 (A11-274): `ReviewBrief.closing`, OPTIONAL: the word the pull request names its ticket with, worked out from its plan step and the run's other pull requests, as the chairman decided it for A11-253: `refs` while it finishes a step
// that is not the last or another pull request of the run is still open, else `closes`. The reviewer accepts `Refs` on every pull request but the last to merge, and asks for `Closes` only on that one. A reviewer of 1.10 ignores it and judges the word by itself.
// 1.10 (A11-290): `ReviewBrief.rereview.planDecisions`, OPTIONAL: the lines of the plan's decisions that changed since the reviewer's last look at the head, for a re-review of a block that a planner's amendment of a decision answers (the replies and the description may then be none).
// The reviewer is bound by the amendment, as it is by the plan's decisions in `planDecisions`, and still reviews the whole diff. A reviewer of 1.9 ignores it and re-reviews by the replies, the description and the ticket's Decisions. A re-review that the verdict door refuses for an equal patch is
// recorded by the board from the verdict file the door keeps beside the reviewer's own (`refused-<file>`), which `verdictFileOf` finds.
// 1.9 (A11-249): `ReviewBrief.closedWork`, OPTIONAL: the work the ticket's earlier pull requests held when they were closed without merging, one line per commit and file, as the board listed it. The pull request body's
// `## Work from closed pull requests` section must say, for each, carried over (where) or dropped (why): the reviewer checks each claim against the diff, and an item left out, or a `carried over` the diff does not show, is a finding.
// A reviewer of 1.8 ignores it.
//
// 1.8 (A11-257): `ReviewBrief.planDecisions` and `ReviewBrief.escalation`, both OPTIONAL. `planDecisions` is the decisions the ticket's plan records (its Key decisions, its Decisions made without a person, and the behaviour the planner settled),
// quoted as the plan words them: they bind the reviewer as the ticket's `decisions` do, and the ticket's win where the two differ. `escalation` is the escalation list, the one thing a decision cannot override. The reviewer does not
// request changes on a point a decision settled; where it disagrees it writes a note and not a finding. A reviewer of 1.7 ignores both.
//
// 1.7 (A11-250): `ReviewBrief.rereview.decisions` and `ReviewBrief.rereview.unsupported`, both OPTIONAL. `decisions` is the lines of the ticket's Decisions that changed since the reviewer's last look at the head, for a re-review of a block
// that a person's decision answers (the replies and the description may then be none). `unsupported` is each reply or new description line that claims a person decided something and does not link the ticket's decisions: the
// reviewer treats it as no answer. A reviewer of 1.6 ignores both and re-reviews by the replies and the description.
//
// 1.6 (A11-221): `ReviewerPort.unblock`, OPTIONAL: looks at the pane of a reviewer herdr shows blocked, answers the one dialog it may answer (Codex's "Trust this folder?" for a repository the host file names) and reports any
// other as stuck, so the pool can tell a person; a look that cannot be made is `unread`, and keeps the last look's finding. A reviewer of 1.5 has no such method and is read as one that never reports a dialog.
//
// 1.5 (A11-235): `ReviewBrief.rereview.body`, OPTIONAL: the lines of the pull request description that changed since the reviewer's last look at the head, for a re-review of a block that was answered by editing the description (the
// replies may then be none). The reviewer checks the answer and still reviews the whole diff. A reviewer of 1.4 ignores it and re-reviews by the replies.
//
// 1.4 (A11-213): `ReviewBrief.decisions`, OPTIONAL: the ticket's explicit decisions, quoted as the ticket words them (a `## Decisions` or `## Behaviour` section, or a line marked as the chairman's decision). The reviewer holds them
// ahead of its own general rules and requests no change for a change they allow. A reviewer of 1.3 is read as one that is given none.
//
// 1.3 (A11-175): `ReviewBrief.step`, OPTIONAL: the plan step a partial pull request finishes (`Partial: step N of M` in its body), and the plan's section for it. The reviewer holds the pull request to that
// step and not to the ticket's whole Done-when, which it is told is for the last step. A reviewer of 1.2 is read as one that is given no step.
//
// 1.2 (A11-172): `start`'s answer may carry `unclaimed`, the reason the head's claim could not be written: with a `refusal`, the claim is why nothing started; without one, the reviewer started anyway because
// this instance is the only one there is.
//
// 1.1 (A11-156): `start` and `reprompt` take a `ReviewBrief`, what the pool knows of the ticket behind the pull request, and a re-review of a head that already has a block starts through `start` too.
//
// A TYPE FILE: it imports nothing at run time. The atomic reviewer (`plugins/atomic-reviewer`, A11-161) implements it; `ticket-mode/reviewer-port.ts` re-exports these types,
// so no caller changed when the contract moved. A machine with no enabled reviewer plugin starts none: "none" is the absence of one.

/** The reviewer contract's version, `<major>.<minor>`: a minor only adds, and a major breaks (`src/plugins/version.ts`). */
export const REVIEWER_CONTRACT_VERSION = "1.11";

/** A pull request at one head: its url, and the commit the reviewer reads and the verdict is on. */
export type ReviewerRef = Readonly<{ pr: string; head: string }>;

/** A reply to a review that asked for changes: who wrote it, where it can be read, and what it says. */
export type ReviewerReply = Readonly<{ author: string; url: string; text: string }>;

/** One line of the pull request description that changed since the reviewer's last look: an old line that is gone (`removed`), or a new one (`added`). */
export type ReviewBodyLine = Readonly<{ kind: "removed" | "added"; text: string }>;

/**
 * What the pool tells a reviewer beyond the pull request (A11-156). `doneWhen` is the ticket's Done-when section, both parts, or null when the pool holds no ticket for the pull request (one a person
 * opened, or a run since removed): then the pull request body is the only copy of the contract the reviewer has. `rereview` is present when the head already has this reviewer's review that asked for
 * changes and something has answered it with no new commit (A11-235): a trusted account has replied to it, or the pull request description changed since the reviewer's last look (`body`, contract 1.5, the changed lines;
 * absent when it did not change). `replies` may then be empty. The reviewer reads the answer and still reviews the whole diff, and its approval names the standing review.
 * `step` is present when the pull request's body says `Partial: step N of M` (A11-175): the pull request is one step of the ticket's plan, `section` is that step's text of the plan, or null when the pool
 * could not find it. The reviewer holds the pull request to that step, and the ticket's Done-when is for the last step.
 * `decisions` is present when the ticket states explicit decisions (A11-213), as the ticket words them, and absent when the pool holds no ticket or it states none: they override a general direction the reviewer holds.
 * `planDecisions` (contract 1.8, A11-257) is the decisions the ticket's plan records, as the plan words them, absent when it records none: they bind the reviewer like `decisions`, which win where they differ. `escalation` (contract 1.8) is the escalation
 * list, present whenever `planDecisions` is: a decision that falls on one of its items does not bind.
 * `closedWork` (contract 1.9, A11-249) is the work the ticket's earlier pull requests held when they were closed without merging, one line per commit and file, absent when there is none.
 * `closing` (contract 1.11, A11-274) is the word the pull request names its ticket with, and the run's other pull requests that decide it; absent when no run holds the pull request, the run holds no other and the body names no step, or a sibling's state could not be read.
 * `rereview.planDecisions` (contract 1.10, A11-290) is the lines of the plan's decisions that changed since the reviewer's last look at the head, absent when they did not change.
 * `rereview.decisions` (contract 1.7, A11-250) is the lines of those decisions that changed since the reviewer's last look at the head, absent when they did not change; `rereview.unsupported` (contract 1.7) is each reply or new
 * description line that claims a person decided something and does not link the ticket's decisions, absent when none does.
 */
export type ReviewBrief = Readonly<{ doneWhen: string | null; decisions?: string; planDecisions?: string; escalation?: string; closedWork?: string; step?: ReviewStep; closing?: ReviewClosing; rereview?: Readonly<{ replies: readonly ReviewerReply[]; body?: readonly ReviewBodyLine[]; decisions?: readonly ReviewBodyLine[]; planDecisions?: readonly ReviewBodyLine[]; unsupported?: readonly string[] }> }>;

/** The plan step a pull request finishes: step `step` of `of`, and the plan's text for it, or null when the pool found none. */
export type ReviewStep = Readonly<{ step: number; of: number; section: string | null }>;

/**
 * The word a pull request names its ticket `key` with (contract 1.11, A11-274): `refs` while it is not the last to merge, `closes` when it is. `open` is the run's other pull requests still open, and `merged` the ones merged, by url.
 */
export type ReviewClosing = Readonly<{ key: string; word: "refs" | "closes"; open: readonly string[]; merged: readonly string[] }>;

/**
 * The port: start a reviewer for a ready pull request at its head, or refuse naming why; say whether one is live for that head; close it once its
 * verdict is posted; retire a pull request's reviewer once it has merged or closed; and list the pull requests whose reviewer workspaces the session holds.
 */
export type ReviewerPort = Readonly<{
  /**
   * Starts a reviewer, once the head is claimed for this instance. `tookOver` says which expired claim was taken over, when one was (A11-149). With `brief.rereview`, the head's standing review
   * is not the end of its claim: the reviewer is started again for the same head (A11-156). `unclaimed` is why the head's claim could not be written (A11-172): on a refusal, the claim is the reason
   * nothing started and the next sweep tries again; on a start, the reviewer began WITHOUT a claim because no other instance is seen, and the board says so.
   */
  start(ref: ReviewerRef, brief?: ReviewBrief): Readonly<{ label: string; tookOver?: string; unclaimed?: string }> | Readonly<{ refusal: string; unclaimed?: string }>;
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
  reprompt(ref: ReviewerRef, brief?: ReviewBrief): PromptAnswer;
  /**
   * OPTIONAL (contract 1.6, A11-221). Looks at the reviewer for `ref` when herdr shows it blocked, and answers a dialog the reviewer may answer by itself (Codex's trust dialog for a repository the host file names): `answered`
   * is the line it answered. Any other dialog is `stuck`, with its first line, and nothing is pressed. Null when the look was made and nothing is showing (the reviewer is not blocked, or its pane shows no dialog). `unread` is a look that could not be made (herdr did not list the session, or the pane could not be read), with why: it says nothing of whether a dialog shows, so the caller keeps what the last look found. A reviewer without the method never reports a dialog.
   */
  unblock?(ref: ReviewerRef): ReviewerDialog | null;
}>;

/**
 * What a reviewer's pane showed when it was blocked on a dialog (A11-221, contract 1.6): the line the port `answered` (a dialog it may answer, and did), the first line of the dialog it left `stuck` for a person, which no
 * key was sent to, or why the pane `unread` could not be looked at.
 */
export type ReviewerDialog = Readonly<{ answered: string }> | Readonly<{ stuck: string }> | Readonly<{ unread: string }>;

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
 * than throwing it (the atomic reviewer's reads the gate's modules); `refusal` says why the reviewer cannot start here, or is null when it can (the atomic reviewer cannot on a host with
 * no `primary`), and needs `load` first.
 */
export type Reviewer = ReviewerPort & Readonly<{
  load(): Promise<void>;
  refusal(): string | null;
}>;
