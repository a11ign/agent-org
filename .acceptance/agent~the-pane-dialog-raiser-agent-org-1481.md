The pane-dialog raiser no longer sends a decision order for the usage-limit menu (`1. Stop and wait for limit to reset` with `3. Switch to usage credits` both on screen). `raisePaneDialogs` in `src/pane-dialog.ts` reads such a pane as showing no dialog (`isLimitMenu` from `src/worker-state.ts`, returned before `readDialog`), so the seat is in neither `sent` nor `refused` and is remembered for nothing; a later different dialog on that seat raises on that later tick. `readDialog`, `dialogOrder` and the signature are unchanged, and a non-limit dialog is raised as before. The account pause (`gate.accountLimitPause`) and `limitMenuTick` are not touched.

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/pane-dialog.test.ts
```

Mutation: the guard in `raisePaneDialogs` was mutated two ways, each restored from a byte copy and checked with `diff` (identical) after its run. Never firing (the guard removed, which is the `main` code) fails the two new cases, `(5f)` and `(5g)`: on `main` the first gives two orders where one is right, and the second raises nothing on tick 1 where the menu seat is a dialog. Always firing (`isLimitMenu(pane) || true`) fails 7 of 16: `(5)`, `(5b)`, `(5c)`, `(5d)`, `(5f)`, `(5g)` and `(6)`, the cases that need an order to be raised.

Measured: `pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/pane-dialog.test.ts` prints `VERDICT pass: 16 tests in 1 file` with the change, and `VERDICT fail: 2 of 16` with the guard removed. `pnpm run typecheck` exits 0. The full package suite (`pnpm test`) fails 112 of 11703 with the change; this is not claimed as a pass. Every file whose import graph reaches `pane-dialog.ts` (the only importer is `work-tick.ts`) was checked: the 28 work-tick importers pass except `src/packaging/work-gate.test.ts`, which fails 37 of 416 both with the change and with `main`'s two files (same failing names); eight `src/packaging` files fail 23 of 105 identically with and without the change. The other failing files do not import `work-tick.ts`.

Closes a11ign/agent-org#1481

Test: `src/pane-dialog.test.ts`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
