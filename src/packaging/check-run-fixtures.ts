/**
 * #1101: THE CHECK-RUN POPULATIONS THE MERGE-PATH TESTS SHARE — a plain module, not a `.test.ts`.
 *
 * **Importing a fixture from a `.test.ts` runs that file's tests inside every importer.** Measured on
 * `1f5897db`, when this lived in `merge-guard-checks-rule.test.ts`:
 *
 *     file                              test() declared   node --test reported
 *     merge-guard-checks-rule.test.ts        21                 21
 *     merge-guard.test.ts                    22                 43
 *     workflow-run-liveness.test.ts           9                 30
 *     TOTAL                                  52                 94
 *
 * So #1093's own pull request published mutation counts — the distinct ones — that its own published
 * acceptance command could not produce, and its reviewer nearly concluded one of the two was wrong before
 * decomposing per file. **The sharing was the right instinct and the vehicle was wrong**: a second copy of
 * the fixture would be the fact-stated-twice shape on the very population under test, so the population
 * moves rather than being duplicated.
 */
/**
 * #1008's head at 23:3xZ, the shape that produced the report — `ts / run` in flight, no `gate` at all.
 *
 * `completedAt` is carried because the CONSUMERS read it: `stalenessReason` compares it to `main`'s tip,
 * and a population of nulls would make it speak and hand those assertions a refusal for a reason that has
 * nothing to do with this row. Dated AFTER the `mainTipIso` they pass, so the only sentence in play is
 * the one under test.
 */
export const LIVE_SHAPE = [
  { id: 1, name: "changed", status: "completed", conclusion: "success", completedAt: "2026-09-12T01:00:00Z" },
  { id: 2, name: "ts / run", status: "in_progress", conclusion: null, completedAt: null },
  { id: 3, name: "acceptance", status: "completed", conclusion: "success", completedAt: "2026-09-12T01:00:00Z" },
  { id: 4, name: "deliberateRefusals", status: "completed", conclusion: "success", completedAt: "2026-09-12T01:00:00Z" },
  { id: 5, name: "python", status: "completed", conclusion: "skipped", completedAt: "2026-09-12T01:00:00Z" },
];
