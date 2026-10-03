// THE ARGV `updatePrimary` ISSUES, OWNED IN ONE PLACE — because it was owned in two and that cost a
// merge-blocking red.
//
// `update-primary.test.ts` asserted the ORDER of the verbs and `primary-checkout-guard.test.ts` asserted
// the full argument lists. Both were correct, neither knew about the other, and when `moveLocalMain`
// added a fourth call on 2026-09-09 the first was updated and the second was found by CI (`not ok 652`).
// A fact stated twice, and the copy that survived was the one nobody was looking at.
//
// The two questions are still different and both are still asked — one file wants the shape of the
// sequence, the other wants every flag — but they are now two readings of ONE list. Adding a call to
// `updatePrimary` fails both until this constant moves, and moving this constant satisfies both at once.
//
// NOT DERIVED FROM `update-primary.mjs`. A list read out of the source it describes asserts that the code
// equals itself, which is the tautology a pinned-argv test exists to avoid. This is a WRITTEN expectation
// that a human has to change deliberately, and the deliberateness is the point.

/**
 * Every git command `updatePrimary` runs, in order, when the shared `main` is already at the target and
 * HEAD did not move.
 *
 * The second entry is the HEAD read taken BEFORE the checkout (#1384): it is what the lockfile question is
 * asked against. Under a stub that answers every `rev-parse` with the same sha, HEAD did not move, so no
 * `diff` follows; the moved-HEAD paths add it and are driven in `update-primary.test.ts`.
 *
 * The last entry is `moveLocalMain` asking where `refs/heads/main` is. Under a stub that answers every
 * `rev-parse` with the same sha it stops there, because the branch needs no move; the BEHIND and DIVERGED
 * paths add `merge-base` and `update-ref` after it and are driven in `update-primary.test.ts`.
 *
 * @type {readonly (readonly string[])[]}
 */
export const UPDATE_PRIMARY_ARGV = Object.freeze([
  Object.freeze(["fetch", "origin"]),
  Object.freeze(["rev-parse", "HEAD"]),
  Object.freeze(["checkout", "--detach", "origin/main", "--quiet"]),
  Object.freeze(["rev-parse", "HEAD"]),
  Object.freeze(["rev-parse", "refs/heads/main"]),
]);

/** The verbs alone, for the test whose subject is the ORDER rather than the flags. */
export const UPDATE_PRIMARY_VERBS = Object.freeze(UPDATE_PRIMARY_ARGV.map((argv) => argv[0]));
