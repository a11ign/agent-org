// module: the login a dependency bot opens a pull request as, in a leaf that imports nothing (a11ign/agent-org#705)
//
// MOVED OUT OF `work-gate/pr-orders.ts`, NOT REWRITTEN: that file imports from `../work-gate.ts` (the cycle its header describes), and
// `failure-recorders.ts` keeps the work gate out of the hand-fix ledger's writer set on purpose, so the ledger could not share the
// pattern from there (#560). It lives here with NO imports so that it can be read from either side; `pr-orders.ts` re-exports it, so
// nothing that reads it from there changes.

/**
 * THE LOGIN A DEPENDENCY BOT OPENS A PULL REQUEST AS (#4624). `gh pr list --json author` spells Dependabot `app/dependabot` (measured on
 * a11ign/a11ign#4470), the REST API `dependabot[bot]`, and a GraphQL `Bot` node plain `dependabot`: all three are the same author. Renovate is
 * named too, because ADR 0041 keeps it as the fallback and the day it is switched on must not reopen this class.
 */
export const DEPENDENCY_BOT_LOGIN = /^(?:app\/)?(?:dependabot|renovate)(?:\[bot\])?$/i;
