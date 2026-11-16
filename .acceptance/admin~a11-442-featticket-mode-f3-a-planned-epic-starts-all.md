The Runs board marks a batch's critical path (A11-442, step 2 of 2). `criticalPaths` in `src/ticket-mode/board-view/critical-path.ts` reads the runs still to finish (each ticket's newest run, not Completed, Cancelled or Checked) and the tracker-listed blockers between them that still hold a run up (not canceled, not one it was stopped for), which is how a planned batch's `order.json` reaches the board; in each set of runs those blockers join, the runs on the longest chain are the critical path. Each such run's note on the Runs page says "On the critical path: A11-500 → A11-501 → A11-502" (`criticalPathNote`, drawn by `noteLines` in `ui/src/runs/runs-model.ts`, after the run's own lines and before its CI line, so a row clamped to two lines cuts the path line, not the run's reason). A lone run, a short branch off the longest chain, a run on a cycle of blockers and an older run of a ticket queued again are on no path. Step 1 (#2044) started the unblocked tickets side by side; this step adds no start or hold rule.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-view/critical-path.test.ts
pnpm ui:build && pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/runs-critical-path.test.tsx
```

Mutation: delete the `criticalPathNote(entry, entries),` line from `linesOf` in `ui/src/runs/runs-model.ts`, and `runs-critical-path.test.tsx` fails: no row says it is on the critical path. Move that line up to just after `stackedOnItNote(entry, entries),` and the second test of that file fails: the reason is no longer the line before it. In `graphOf` in `critical-path.ts`, use `[...open].sort()` for `keys` (cycle members kept), and the cycle test fails.

Consumer-declaration: none -- no host file key, contract or queue field changes.
