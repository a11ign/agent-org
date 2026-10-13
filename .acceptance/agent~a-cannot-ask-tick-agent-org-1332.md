A tick that exits `CANNOT_ASK` (both primary lanes refused, so `main` cannot say what is open) now records ONE blind sample before it exits. `cannotAskExit` (`src/work-gate.ts`) writes the report, hands the refused lanes to `tickLanes`, and returns `EXIT.CANNOT_ASK`; `main` takes that code before its pacing read and exits with it, so `blind-ticks` reads 1 for that tick. The normal tick goes through the same `tickLanes`, which maps the refused lanes to `unreadLanes`. A tick that read its lanes samples 0; a paced repository the gate skips by design is not blind (#1329), though PARTIAL still names it. `machineryCanaryTick` (`src/org-health.ts`) keeps the held-order clocks (`held:<key>`) when no suppressions are passed, so a blind tick does not restart a 15-minute hold; an empty list still means nothing is held and expires them. `machineryValues` keeps the approved-unqueued clocks (`unarmed:<pr>`) when the unarmed read is refused, rather than restarting them on the blindest ticks. `machineryCanaryNow` (`src/work-gate/causes/org-health-github-incident.ts`) passes `suppressions` through without defaulting it to `[]`.

Threshold, during a shared outage: a flag's baseline is `windowOf` over the hour before the flag went on, so an outage that already ran through that hour is the baseline and is not a rise. A flag switched on inside a sustained outage passes; a healthy hour followed by a sudden outage reverts (three blind ticks clear `minRise`). This is the intended delta semantics, and the tests pin both sides.

Acceptance: `node --test src/work-gate.test.ts src/packaging/machinery-canary.test.ts` (35 tests: 11 in `work-gate.test.ts`, 24 in `machinery-canary.test.ts`). Of the canary file's 24, the #1332 block is five: the exit's behaviour (its exit code, its stderr report, its one blind sample, and a read tick's `null` with no sample), the exit's placement in `main` (a source pin), the held clocks surviving a blind tick that asked no suppressors, the unarmed clocks surviving a refused read, and the threshold in both directions. The #1329 block is one test that drives `tickLanes` through each refused lane and through a paced one. Against the 37 of the earlier cut, this removes the source pin on the paced exclusion (`#1329 (1)`, now behavioural), the separate paced-only test (`#1332 (1c)`, now inside the #1329 test), and folds the refused-lane cases into one test.

Mutation: with each source backed up, changed by one exact string, and restored by `cp` and proven byte-identical by `Buffer.equals` after each case (`node` scripts in the scratchpad, not git). Each row is the number of failing tests, then the tests named:
- M1, the unarmed-clock guard `facts.unarmed === null ||` removed: 1 (the unarmed one).
- M2, held clocks dropped on a tick with no suppressors asked (`memo: {}`): 2 (the held one and the unarmed one).
- M3, `suppressions` defaulted to `[]` in `machineryCanaryNow`: 1 (the held one).
- M4, `cannotAskExit` records no blind sample (its `tickLanes` call replaced by a no-op): 2 (the exit's test and the threshold).
- M5, `tickLanes` hands the canary no refused lanes (`unread: []`): 3 (the #1329 test, the exit's test and the threshold).
- M6, `cannotAskExit` exits only when BOTH lanes are refused: 1 (the exit's test).
- M7, paced repositories counted as blind: 1 (the #1329 test).
- M8, PARTIAL stops naming the paced repositories: 1 (the #1329 test).
- M9, `main` does not exit on the seam's code (the `process.exit` line replaced by a no-op): 1 (#1332 (1b)). Before the placement pin named that line, this mutation failed no test.
- M10, `main` drops the canary's orders (`orders.push(...lanes.orders)` removed): 1 (#5100 THE TICK CALLS IT).

Measured: `ℹ tests 35, pass 35, fail 0` for the acceptance command, run in the worktree. `pnpm run typecheck` exits 0 with no errors. `pnpm test` (rstest): `VERDICT fail: 5 of 11352 tests failed in 682 files`, in `host-install-agent-org-launcher`, `live-tree-independence` (2), `multi-board-gate` and `release-tag-on-merge`: the same five as before this rework. The 11352 is the earlier cut's 11354 less the two canary tests folded into one. The same five fail at HEAD (`791aa07a`, a `git archive` copy with the worktree's `node_modules`) when those four files are run alone, which the earlier cut measured. None of the five is a canary test.

The rework broke two source pins outside the acceptance command, and both now pin `cannotAskExit` instead of `main`: `src/packaging/work-gate.test.ts` (#2003: the report is built after the refused-read early return, and `main` passes identity lazily) and `src/work-gate-one-wave.test.ts` (the outage check is `cannotAskExit({`, before the one wave). Both pass in the full run.

Not run against `main`: the new tests import `cannotAskExit` and `tickLanes`, which `main` does not have, so the file does not load there. The behaviour `main` has (no blind sample from a CANNOT_ASK tick) is what M4 and the exit's test catch.

Not here, and named: `main()` is not driven whole by any test (it calls `gh` in several places and exits in several branches). The exit's placement and its `process.exit` line (`#1332 (1b)`), and the normal tick's `orders.push(...lanes.orders)` (`#5100 THE TICK CALLS IT`), are source pins; the behaviour of both seams (`cannotAskExit`, `tickLanes`) is driven, and the wiring inside `main` is not.

Closes a11ign/agent-org#1332

platform: linux, Node v24.21.0; the canary is pure over the `CanaryIo` seam (a memory store in the tests), so no host state, `gh`, or `machinery-canary.json` is read.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
