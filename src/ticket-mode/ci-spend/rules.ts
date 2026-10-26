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
 * What a worker is told about re-running checks while it works (A11-307): one cached check of the change, and the full commands only on a fallback. Said once and quoted by the worker brief and the shipped
 * house notes, like the rule above. It is for a repository that has the command, so another repository's worker reads it as "use yours": its own `AGENTS.md` names the commands.
 */
export const CHECK_CHANGED_RULE = "Where the repository's `AGENTS.md` names a `check:changed` command (agent-org's is `pnpm run check:changed`), run it while you work and before you push, instead of the full test and lint commands: "
  + "it lints the changed files with a cache, typechecks the whole program, and runs the tests that import a changed file at any depth, and it prints what it ran and why. "
  + "The full `pnpm test` and `pnpm run lint` are for a fallback: when its output says FALLBACK it has run the whole suite and the whole lint itself, so do not run them again on top. "
  + "CI still runs every suite on every push and is the gate.";

/**
 * The section a brief opens with when the ticket's CI passed twice its budget and the board held the run, or told its finished run before this round (A11-261): why, what that means for the work already done, and the rule again. A run that was
 * not held gets the empty string, so its brief is what it was. The reason is the board's own words, never a person's or a tool's.
 */
export const heldText = (reason: string | undefined): string => (reason === undefined ? "" : `## The board held this run

${reason}. The board holds a run whose ticket has spent this much CI, to break a loop of pushes. Your worktrees and commits are as you left them: carry on from where you stopped. Do not push again until your changes are complete and the repository's own checks pass locally, then push once.

${PUSH_ONCE_RULE}

`);
