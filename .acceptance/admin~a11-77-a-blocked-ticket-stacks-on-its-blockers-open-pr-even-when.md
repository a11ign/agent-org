A planner can say a ticket waits for its blocker to merge. `order.json` takes `"wait": "merged"` beside `after`: `batch-order.ts` reads it (`stacked` when absent, and `stacked` is accepted as the explicit default; any other value refuses the whole order), `queue.ts` `batchPlanDone` keeps the blockers it names on the entry as `waitMerged`, and `board-view.ts` never stacks on such a blocker. A merged-wait blocker lets go once the tracker completes it or its pull requests have merged (none open, one merged; a canceled or duplicate blocker never lets go). The row says "Waits for NBF-1 to merge". The batch planner's brief teaches the choice: stacking for code that builds on the blocker's diff, merged for work that needs the blocker's change live. Without the field nothing changes: the existing stacking test in `board-view.test.ts` passes unchanged.

Acceptance:
```bash
node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts --testNamePattern "A11-77" src/ticket-mode/batch-order.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/pool.test.ts
```

Evidence: the six files whole, with a CI-shaped fixture host (`AGENT_ORG_HOST`), give `VERDICT pass: 319 tests in 6 files` (313 before, plus six new). Without a host, eight reviewer tests in `pool.test.ts` fail on the base too, which is why the block above names only the new tests. Typecheck: no error in `src/ticket-mode/`; the project's other type errors are missing modules in this machine's partial install and are not in the files changed here.

Mutation: ten breaks, each restored and confirmed byte-identical with `cmp`, each caught: the merged-pulls rule removed (2 tests), the merged mark ignored for stacking (3), the canceled guard removed from the merged rule (1), the pool dropping `waitMerged` (1), `wait` not validated (1), `batchPlanDone` dropping `waitMerged` (2), `mergeWaits` inverted (2), the merged guidance reworded (1), the row's note omitted (1), the note naming a blocker the planner did not mark (1).

Base: the six new tests fail on the base source (`0b649866`); the existing stacking test passes there and here. Three existing tests fail on the base only because their pinned data changed: the parsed order now carries `wait`, the parse refusal names the new shape, and the batch brief's `order.json` shape string includes `wait`.

Left open: the `wait` field is per ticket, not per blocker, and applies to every ticket in that entry's `after`. A `wait` for a blocker in another repository is not built: such a blocker already waits, since it never stacks.
