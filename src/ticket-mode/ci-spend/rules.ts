// module: the rule that keeps a worker's CI spend down, said once and quoted by the worker brief and the shipped house notes (A11-261)
//
// EVERY PUSH RUNS THE REPOSITORY'S WHOLE CI, and a macOS minute costs ten times a Linux one, so a worker that pushes "to see what CI says" or pushes
// fix-ups one at a time spends the most for the least. The rule is in the brief and not only in the house notes because a notes file that exists is
// never overwritten (`install/house-notes.ts`): a machine that installed earlier would otherwise never show it to its workers.

/** What a worker is told about pushing: test locally first, push once per meaningful change, and keep heavy workflow jobs off draft pull requests. */
export const PUSH_ONCE_RULE = "Run the repository's tests, typecheck and lint locally before you push, and push once per meaningful change. "
  + "Never push only to see what CI says, and never push fix-ups one at a time when they can be batched: every push runs the repository's whole CI, and macOS minutes cost ten times Linux's. "
  + "A workflow you add or change keeps its heavy jobs off a pull request while it is still a draft.";
