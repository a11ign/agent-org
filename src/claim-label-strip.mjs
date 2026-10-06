// @ts-check
// #3883: THE CLAIM LABELS A CLOSED ROW SHOULD NOT KEEP, AND THE ONE ACT THAT TAKES THEM OFF, in a leaf of its own so the work gate can strip them without
// importing `close-rows-for-merged-pr.mjs`. That file reaches `row-claim.mjs` -> `wake.mjs` -> `arm-pr.mjs`, which reads `.agent-org/roles` at import, and
// #2174 requires the gate to load in a copied closure that carries none (`src/packaging/work-gate.test.ts`). The decision and the act are MOVED, not copied:
// the close paths and the audit still import them from `close-rows-for-merged-pr.mjs`, which re-exports `labelsToStrip` and binds `stripClaimLabels` to its
// own guarded `gh`. Imports only leaves, so the gate keeps the property its own header states.
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

/**
 * #754: strips the row's claim labels, and never throws -- it only reports. A label-removal failure must NEVER prevent or roll back a close (the close is the
 * point; a row that closed with a stale label is strictly better than one left open because a label edit failed), and the work gate (#3883) is a tick that
 * must keep going past one refused edit. The caller supplies the two things that differ between callers: `gh` (the close paths' own guarded spawn, or the
 * gate's timed one) and `say` (`console.log` for a close, STDERR for the gate, whose stdout is its orders and nothing else).
 *
 * The result says which of the three happened, because "nothing to strip" and "could not strip" must not read the same to a caller that counts what it did.
 * @param {number} n @param {string[]} labels @param {string} repo
 * @param {{ gh: (args: string[]) => unknown, say: (line: string) => void, logPrefix?: string }} deps
 *   `logPrefix`: the immediate path logs `CLOSE-ROWS:`, the sweep logs `SWEEP:`, the gate `GATE:` -- callers must stay distinguishable in the log, the same
 *   reason close-rows-sweep.mjs's own header gives for never reusing `CLOSE-ROWS:` itself: which path did the work is a fact about the pipeline's health.
 * @returns {"nothing" | "stripped" | "failed"}
 */
export function stripClaimLabelsVia(n, labels, repo, { gh, say, logPrefix = "CLOSE-ROWS" }) {
  const toStrip = labelsToStrip(labels);
  if (toStrip.length === 0) return "nothing";
  try {
    gh(["issue", "edit", String(n), "--repo", repo, ...toStrip.flatMap((l) => ["--remove-label", l])]);
    say(`${logPrefix}: #${n} stripped ${toStrip.join(", ")}.`);
    return "stripped";
  } catch (cause) {
    say(`${logPrefix}: #${n} closed but COULD NOT STRIP ${toStrip.join(", ")} -- `
      + `${cause instanceof Error ? cause.message : cause}`);
    return "failed";
  }
}
