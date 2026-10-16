// @ts-check
// A LEAF, IMPORTING NOTHING: the label that is a hold on a pull request, and who holds one. Moved out of `pr-hold-state.ts`, which re-exports
// both, so `red-pr.ts` decides what a hold excuses without importing that file's graph, which reads the project declaration at import and so
// cannot load on a machine that declares none, such as ticket mode's (`src/ticket-mode/settings.ts`).

/**
 * THE LABEL PREFIX THAT IS A HOLD ON A PR. Exported, because it is now the ONLY spelling: three copies
 * of the old one were what made this rename a rename rather than an edit.
 *
 * IT WAS `session:` UNTIL 2026-09-09, AND THAT WAS ONE WORD DOING TWO JOBS. `session:<name>` also means
 * OWNERSHIP — who is working on a row, and, since ceo's 12:2xZ ruling, who opened a PR. orchestrator
 * applied `session:orchestrator` by hand to twelve PRs that day to mark them as theirs, and every one of
 * them was, as far as this file was concerned, HELD. Eleven merged anyway, which is a separate finding;
 * the point here is that the collision made "held" unreadable, and #725 was about to apply the label to
 * every armed PR in the org.
 *
 * A `session:` label on a PR is never consulted by the hold path again (ceo, 2026-09-09). Rows keep
 * `session:` — `row-claim.ts` and `ready-label-audit.ts` are unchanged and MUST stay that way, which
 * is why this constant is not shared with them.
 *
 * WHAT THIS RENAME DOES NOT DO: it does not make a hold stop a MERGE. The hold is enforced at ARM time —
 * `pr-hold` disarms when it takes the hold, and `armabilityOf` below stops anything re-arming. Nothing in
 * the required `gate` context consults a label: `merge-guard.ts --ci-gate` calls `mergeSafetyVerdict`,
 * which reads head-vs-tip and nothing else. So a hold placed on an ALREADY-ARMED PR still stops nothing,
 * before this rename and after it. Recorded here rather than left to be discovered, because a reader who
 * sees a namespace built for holds will reasonably assume the holds are enforced.
 */
export const HOLD_PREFIX = "hold:";

/**
 * Who is holding this PR, if anybody.
 * @param {string[]} labels
 * @returns {string[]}
 */
export function holdersOf(labels: string[]): string[] {
  return labels.filter((l) => l.startsWith(HOLD_PREFIX));
}
