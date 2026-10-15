The ledger's graphql points for counter-less lines are shared out between the counter readings around them, not floored at one (agent-org#1482). `settle` in `src/gh-ledger.ts` keeps one baseline PER RESET WINDOW, not per account: `app:scheduler` runs several token pools, each on its own reset clock (2026-10-15 16Z: four reset epochs in one hour). A counter-less line between two readings of the same window now takes its share of the movement between them, and `host/gh`'s `rollup_dropped` (the trim that writes the hourly rollup) ports the same rule, so a rolled-up hour is settled the same way as a live one.

Acceptance:

```bash
node --test src/gh-ledger.test.ts
```

Closes a11ign/agent-org#1482

Measured: `node --test src/gh-ledger.test.ts` printed `ℹ tests 30 / ℹ pass 30 / ℹ fail 0` at this head, including the new test "#1482: a counter-less line between two readings of ONE reset window is shared out between them, with another window's readings in between" and "#1482: another window's BASELINE between a counter-less line and the next reading of its own window does not clear the line's share". `node --test src/packaging/gh-ledger-per-hour.test.ts` printed `ℹ tests 12 / ℹ pass 12 / ℹ fail 0`, including "#1482: the rollup a trim writes holds what `settle` makes of the dropped lines" and the trim test for the reviewer's ordering. `pnpm run typecheck` exits 0. Mutation, run and reverted byte-identical: `settle` with one baseline (`before.get(0)` in place of `before.get(e.reset)`) fails the new #1482 test in both files. Real 16Z reading: the counter moved 1979 -> 2350 with a floor of 4788 and a raw movement of 4878 (about 2% apart).

Outside-Region: `src/packaging/gh-ledger-per-hour.test.ts`. It runs the real `host/gh` wrapper through a trim, so it cannot live in `src/gh-ledger.test.ts`; its one new test is the reconciliation between the rollup a trim writes and `settle` run over the same dropped lines.

Not done: done-when 2 (the next whole UTC hour read by `node src/gh-ledger.ts ~/workers/gh/gh-calls.tsv --account app:scheduler --resource graphql --per-hour`, within 10% of the pool counter) waits for that hour after merge. The `.hourly` rollups already written for 13Z and 14Z are floor-only and are not corrected by this change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
