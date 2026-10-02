// #2995: THE CLAIM LABELS A CLOSED ROW SHOULD NOT KEEP, in a leaf of its own so the work gate can strip them without importing
// `close-rows-for-merged-pr.mjs`. That file reaches `row-claim.mjs` -> `wake.mjs` -> `arm-pr.mjs`, which reads `.agent-org/roles` at
// import, and #2174 requires the gate to load in a copied closure that carries none. The decision is moved, not copied: the
// close paths and the audit still call it from `close-rows-for-merged-pr.mjs`, which re-exports it.
import { READY_LABEL, CLAIM_LABEL, STARTED_LABEL } from "./claim-labels.mjs";
import { SESSION_PREFIX } from "./project-vocabulary.mjs";

/**
 * #754: which of a row's CURRENT labels a merge-driven close must strip, IN THE SAME ACT as the close --
 * `ready` (it is no longer pickable), `in-progress`/`started` and any `session:*` (the claim is over), so
 * `audit`'s recurring DEBRIS finding -- *"a closed row still carries a pickable/claimed label"* -- stops
 * being PRODUCED by this path rather than being cleared by hand each hour.
 *
 * `answer:<session>` IS DELIBERATELY NEVER IN IT EITHER, AND IT IS THE OPPOSITE REASON (#2202). `was-ready`
 * is kept because it is a record; `answer:*` is kept because it is a LIVE DEBT -- the only machine-readable
 * "a named session still owes an answer here". Stripping it on close would erase the question in the same
 * act that ends the wake, so the row would read as answered when it was merely closed; that is the exact
 * silence this row (#2202) exists to end. The gate's closed-row read (`readClosedAnswerRows`) keeps waking
 * the session, and the session clears the label by answering. The price, stated: a closed row can wear a
 * live `answer:` label, and that is what it MEANS now, not debris -- `audit`'s DEBRIS finding is about
 * claim labels, which are on this list.
 *
 * `was-ready` is DELIBERATELY NEVER in this list. It is a record of what the row WAS, not a claim on it
 * (#703 still carries it correctly, and this must not change that) -- the same distinction
 * `declineRemoveLabels` in `row-claim.mjs` draws for the identical label on a different path.
 *
 * Safe on a row missing any of these: the caller strips only what `currentLabels` actually contains, and
 * `gh issue edit --remove-label` is itself a harmless no-op on a label a row does not carry.
 *
 * @param {string[]} currentLabels
 * @returns {string[]}
 */
export function labelsToStrip(currentLabels) {
  return currentLabels.filter((label) => label === READY_LABEL || label === CLAIM_LABEL
    || label === STARTED_LABEL || label.startsWith(SESSION_PREFIX));
}
