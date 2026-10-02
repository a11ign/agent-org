/**
 * #2358: WHO ACTS WITH `A11IGN_BOT_TOKEN`, named once so the two files that use the answer cannot disagree.
 *
 * `auto-arm-token.test.ts` (token-free, a row's Acceptance command) pins that the holder is a machine account,
 * and `auto-arm-token-live.test.ts` (spawns `gh`) reads the acting identity back from GitHub and compares it
 * with THIS holder. Two copies of the name would let one be moved without the other; one constant cannot.
 * Moving any of them is a decision that belongs on a row.
 */

/** The secret every arming workflow step reads. */
export const SECRET_NAME = "A11IGN_BOT_TOKEN";

/** The machine account expected to hold it, and that no session uses. */
export const SECRET_HOLDER = "a11ign-ci";

/** Accounts that must never act with the secret: the chairman's personal one, whose token it used to be. */
export const PERSONAL_ACCOUNTS = ["DanBeckDev"];

/**
 * Accounts that are somebody's identity rather than CI's, and so must never HOLD the secret: the reviewer
 * (the account that approves must not arm and complete the merge, or `main`'s review requirement is
 * decorative -- `.claude/rules/main-review-requirement.md`) and the two session identities (CI's merges
 * would be attributed to whichever session holds them).
 */
export const NOT_CI_ACCOUNTS = ["a11ign-bot", "a11ign-ai-workers", "a11ign-ai-leads"];

/** The org-level secret was updated at this instant; earlier merges were made under the old token. */
export const SWAPPED_AT = "2026-09-24T19:54:17Z";
