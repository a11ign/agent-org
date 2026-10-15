The cost file is cut to its newest half past `TICK_COST_BYTES`, which rises from 2 MiB to 4 MiB, so the half it keeps is 2 MiB: about 800 ticks and 30 hours at the readback's rate, where 1 MiB held about 15 hours. The trim test gains one assertion: after the trim the file is at least the cap's half less one line, and that half is at least 1.6 MiB, a day at the measured rate.

Acceptance:

```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/work-tick-cost.test.ts
```

Closes a11ign/agent-org#1379

Revert: restore `TICK_COST_BYTES = 2 * 1024 * 1024` and the comment above it, and drop the assertion and the `statSync` import from the test.

Mutation: `TICK_COST_BYTES` back to `2 * 1024 * 1024` -> 1 red, the trim test (`1126400 bytes kept`), and 44 green. Restored from a copy and `diff`ed byte-identical.

Measured: the Acceptance printed `VERDICT pass: 45 tests in 1 file` at this head, and 45 at the base before the change. `pnpm run typecheck` exited 0. This package has no `lint` script, so no lint was run.

Full `pnpm test` at this head: `112 of 11614 tests failed in 699 files`. The 25 failing files are under `src/packaging/` and `src/work-gate*`, plus two others. None imports `work-tick.ts` (`work-gate.test.ts` names a unit string, not an import), and the same 25 files on a clean HEAD give `112 of 733 tests failed in 25 files`. They predate this change.

Not checked: done-when 2 (the readback over `tick-cost.jsonl` spanning 24 h) needs a day of ticks in the file, so it is a later reading.

Outside-Region, not changed: `docs/gate-phase-profile.md:7` still says the cap is 2 MB and the file starts at a 2026-10-14 tick. It is a row's doc to correct, not this diff.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
