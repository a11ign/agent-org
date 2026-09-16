#!/usr/bin/env node
// @ts-check
// RULE: DID EVERY RUN AT LEAST FINISH AFTER `main`'S CURRENT TIP WAS COMMITTED? -- a REAL result against a
// base that has since moved, which is what makes it look like evidence rather than a gap.
//
// Measured 2026-09-07: #100's newest run finished 00:45:35Z against a `main` tipped 00:41:07Z and is
// current; #135's finished 00:08:02Z against that same tip and is not. The comparison is deliberately
// against the COMMIT DATE of `main`'s tip rather than against a run of `main`, because what matters is
// whether this head was ever tested alongside the code it is about to join.
//
// KEPT SEPARATE FROM `ancestry-rule.mjs`, deliberately -- a run can finish AFTER `main`'s tip was committed
// while the branch still does not CONTAIN that commit (ordinary concurrent merging), so a clock comparison
// and a graph comparison can disagree and need to be reported as the two distinct faults they are. See
// `ancestry-rule.mjs`'s own comment for the incident (#182) that separating them exists to fix.

/**
 * @param {{completedAt: string | null}[]} runs
 * @param {string} mainTipIso
 * @returns {string[]}
 */
export function stalenessReason(runs, mainTipIso) {
  const finished = runs.map((run) => run.completedAt).filter(Boolean).sort();
  const newest = finished[finished.length - 1];
  if (!newest || newest >= mainTipIso) return [];
  return [`EVERY RUN PREDATES THE CURRENT main. Newest run ${newest}, \`main\` tipped ${mainTipIso}.\n`
    + "  These runs are real results, which is what makes them misleading: they tested this head against\n"
    + "  a base that has since moved. Update the branch and let it re-run."];
}
