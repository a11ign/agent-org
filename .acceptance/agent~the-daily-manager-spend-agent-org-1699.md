The daily manager-spend post lists the day's wakes by cause, and the rows add up to the day's wake total. `managerSpendReading` returns `causes` (wakes, wakes served by a run, and the share of the day's wakes, grouped by the wake's `cause`, with a null cause as `(no cause)`), and `renderReading` prints them as a second table under the first. The first table is unchanged, byte for byte, and a test pins it.

Acceptance:

```bash
node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/trace/manager-spend.test.ts
```

Mutation, the file backed up to the scratchpad with `cp`, changed, run, restored with `cp` and proven byte-identical with `diff`:
- A: the wakes with a null `cause` skipped in the grouping: 2 red, `the first table is pinned byte for byte` and `POSITIVE CONTROL: the day's wakes group by cause`.

Measured:
- Acceptance run in the worktree, the same command as the row's with the `cd` to the primary clone left off so it tests this change: `pass: 10 tests in 1 file` (8 before, the 2 new ones after).
- `pnpm run typecheck` exits 0.
- `pnpm run lint` does not exist in this package (`ERR_PNPM_NO_SCRIPT`), so it was not run.

The next daily post at 06:45Z is the last check of the row's Done-when 3 and is not run here.
