// module: the `gh` config directory the reviewer instances act as -- a leaf, so what only needs the name does not load the gate (A11-172)
//
// `review-trust.ts` holds the reviewer's trust rules and its imports reach the project declaration; the doctor's policy for a code host (`plugins/policy.ts`) needs only this one path, and an instance that
// starts no reviewer must never load those modules (`serve-ticket-only-host.test.ts`). `review-trust.ts` re-exports it, so every reader of the constant there is unchanged.

/**
 * The `gh` config directory the reviewer instances act as (`a11ign-bot`). Its login is a declared identity: a pull request the reviewer
 * itself opened is the org's own work. It is `/home/agent/reviewer/gh` on the host, as `wake.ts` names it.
 */
export const REVIEWER_GH_CONFIG_DIR = "/home/agent/reviewer/gh";
