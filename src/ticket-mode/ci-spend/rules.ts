// module: the rule that keeps a worker's CI spend down, said once and quoted by the worker brief and the shipped house notes (A11-261)
//
// EVERY PUSH RUNS THE REPOSITORY'S WHOLE CI, and a macOS minute costs ten times a Linux one, so a worker that pushes "to see what CI says" or pushes
// fix-ups one at a time spends the most for the least. The rule is in the brief and not only in the house notes because a notes file that exists is
// never overwritten (`install/house-notes.ts`): a machine that installed earlier would otherwise never show it to its workers.

/** What a worker is told about pushing: test locally first, push once per meaningful change, and keep heavy workflow jobs off draft pull requests. */
export const PUSH_ONCE_RULE = "Run the repository's tests, typecheck and lint locally before you push, and push once per meaningful change. "
  + "Never push only to see what CI says, and never push fix-ups one at a time when they can be batched: every push runs the repository's whole CI, and macOS minutes cost ten times Linux's. "
  + "A workflow you add or change keeps its heavy jobs off a pull request while it is still a draft.";

/**
 * The section a brief opens with when the ticket's CI passed twice its budget and the board held the run, or told its finished run before this round (A11-261): why, what that means for the work already done, and the rule again. A run that was
 * not held gets the empty string, so its brief is what it was. The reason is the board's own words, never a person's or a tool's.
 */
export const heldText = (reason: string | undefined): string => (reason === undefined ? "" : `## The board held this run

${reason}. The board holds a run whose ticket has spent this much CI, to break a loop of pushes. Your worktrees and commits are as you left them: carry on from where you stopped. Do not push again until your changes are complete and the repository's own checks pass locally, then push once.

${PUSH_ONCE_RULE}

`);
