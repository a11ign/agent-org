`api-pool-low`'s Spender sentence says `; the pool's own used points are N and the ledger accounts for P% of them` (and `, under 90%, so M points were spent by calls this ledger does not hold` below 90%). The used points are handed to the sentence by `poolLowReading` and the clause is built in `spenderPhraseFor` (`src/gh-ledger.ts`), where the ledger's total is. `settle` records the movement a reading closed (`LedgerEntry.moved`), `host/gh`'s `rollup_dropped` writes it as the rollup row's 8th field and `parseRollup`/`perHour` read it back as `moved`; `--per-hour` prints it when present.

Acceptance:
```bash
node --test src/org-health-app-spender.test.ts src/packaging/gh-ledger-per-hour.test.ts
```

Mutation 1: the awk's write of the 8th field was disabled (`if (0) printf`) and `host/gh` restored from a copy with `cmp` (byte-identical). The new rollup test fails (3 failures in all: it and the two older rollup/deepEqual tests that read the row back).

Mutation 2: the "under 90%" test was made always true, then never true (`share >= 0` / `share < 0`), `src/gh-ledger.ts` restored from a copy with `cmp` each time. Always: the 1395 and 1420 sentence tests fail (2). Never: the same two plus the three tests that pin the sentence (5).

Measured: the Acceptance command prints `ℹ pass 21`, `ℹ fail 0` with the change. `src/packaging/host-project-paths.test.ts` moved its wrapper digest pin (the wrapper changed).

Closes a11ign/agent-org#1420

Test: `src/packaging/gh-ledger-per-hour.test.ts`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
