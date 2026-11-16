The Runs board marks a batch's critical path (A11-442, step 2 of 2). `criticalPaths` in `src/ticket-mode/board-view/critical-path.ts` reads the runs still to finish (not Completed or Cancelled) and the tracker-listed blockers between them, which is how a planned batch's `order.json` reaches the board; in each set of runs those blockers join, the runs on the longest chain are the critical path. Each such run's note on the Runs page says "On the critical path: A11-500 → A11-501 → A11-502" (`criticalPathNote`, drawn by `noteLines` in `ui/src/runs/runs-model.ts`). A lone run, a short branch off the longest chain and a chain through a cycle of blockers are on no path. Step 1 (#2044) started the unblocked tickets side by side; this step adds no start or hold rule.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-view/critical-path.test.ts
pnpm ui:build && pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/runs-critical-path.test.tsx
```

Mutation: delete the `criticalPathNote(entry, entries),` line from `linesOf` in `ui/src/runs/runs-model.ts`, and `runs-critical-path.test.tsx` fails: no row says it is on the critical path. In `throughOnce` in `critical-path.ts`, return `chain` whatever it repeats, and the cycle test fails with "A-2 → A-1 → A-2 → A-3 names a run twice".

Consumer-declaration: none -- no host file key, contract or queue field changes.
