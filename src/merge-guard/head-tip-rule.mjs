#!/usr/bin/env node
// @ts-check
// RULE: DOES GITHUB'S RECORDED HEAD MATCH THE BRANCH'S REAL TIP? -- #294, found on #195: `gh pr checks`
// and every check-run lookup are keyed on `pr.headRefOid`, which is GitHub's own bookkeeping and not the
// branch itself. A push GitHub has not yet indexed (or any other cause) leaves `headRefOid` pointing at
// the tip's PARENT, and every "green" belongs to that older commit -- including one whose own commit
// message says a later commit refuted it.
//
// Deliberately its OWN rule rather than folded into ancestry (behind `main`) or staleness (runs older than
// `main`'s current tip): those need opposite remedies from this one. Behind `main` -- update the branch.
// Runs predate `main` -- re-run. GitHub's head is not the tip -- RE-PUSH, so GitHub picks up the commit
// that is already there. This is also the ONE rule `mergeSafetyVerdict` (the self-reference-safe CI-gate
// check, in `merge-guard.mjs`) composes on its own -- see that function's own comment for why ancestry and
// closing-claim are deliberately excluded from a required job asking about its own commit.

/**
 * @param {{headRefOid: string}} pr
 * @param {string} branchTip
 * @returns {string[]}
 */
export function headTipMismatchReason(pr, branchTip) {
  if (branchTip === pr.headRefOid) return [];
  return [`GITHUB'S HEAD IS NOT THE BRANCH TIP: GitHub recorded ${pr.headRefOid.slice(0, 10)}, the branch's `
    + `real tip is ${branchTip.slice(0, 10)}.\n`
    + "  Every check below belongs to the recorded head, which is not the commit that would actually merge.\n"
    + "  Re-push the branch so GitHub picks up the real tip, then ask again."];
}
