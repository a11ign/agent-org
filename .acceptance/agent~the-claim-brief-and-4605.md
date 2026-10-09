The claim brief and every later wake say `your claim blocks N rows (#a, #b, ...)`, so a holder treats landing as its first job (a11ign/a11ign#4605, fix 4 of 4 for the lock-gridlock class, epic #4437).

- `src/blast-tail.ts` (new): `blastTail(row, record, now)` is the line as a tail (`""` when nothing is shelved), `shelvedBehind` is the list it prints, read from the holdings the gate's own count wrote, and `readBlockingRecord` is the one file read (an absent record is quiet, an unreadable one is reported).
- `src/wake.ts`: `addressed` appends `blastTail` after `calmTail` and `tripsTail` on the `spawned` path, which is the spawned order AND every later wake for a claimed row; `promptTarget` reads the record once per delivery. `addressed` takes `blocking` (default none) and `now`, so no test reads host state.
- `src/blocking-impact.ts`: `BlockingRecord.holdings` keeps the LAST tick's `Holding` for every holder. Before this the record kept only episodes (5 rows or more) and per-tick counts, so the rows of a holder blocking 1 to 4 were not on disk and the line could not name them.

Outside-Region: `src/blocking-impact.ts` — the record did not keep the rows of a holder below the incident threshold, and the row asks for the line at 1 to 4 rows; a two-line change (the type and `advance`).
Outside-Region: `.changeset/the-claim-brief-says-what-it-blocks.md` — the changeset every change here carries.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/blast-tail.test.ts
```

Closes: a11ign/a11ign#4605

Verified (measured in this worktree, `AGENT_ORG_HOST=/home/agent/repos/wt-4605/.agent-org/host.json`): `blast-tail.test.ts` 9 pass; with `blocking-impact.test.ts`, `src/wake*`, `src/packaging/wake-order-shape.test.ts`, `src/work-gate*` and `src/org-retro*` 703 tests in 54 files pass. `tsc --noEmit`: only the two existing `src/packaging/mjs-ratchet.test.ts` errors (the same as on `origin/main`); the one error my test had was fixed.

Done-when 2 (fixture, not a live wake): the live `blocking-impact.json` was written before `holdings` existed, so a real wake cannot carry the line until the gate has ticked once on this code. The fixture: a holder with rows #4701, #4702, #4703 shelved behind it gets `Landing this is your first job: your claim blocks 3 rows (#4701, #4702, #4703), which the gate cannot offer while you hold this Region. Land it, split the Region, or release the claim.` appended to the spawned order and to a follow-up wake.

Mutation: seven single-line mutations, one at a time against `blast-tail.test.ts`, each file restored byte-identical (`cp` before, `diff` after): tail never prints (4 tests red), tail always prints even for an empty list (3), every holder's rows counted as this holder's (1), a stale record never refused (1), every record refused as stale (5), `wake.ts` not appending the tail (1), and `advance` not writing `holdings` (5).

platform: checked whether GitHub, systemd or git state could tell a holder what its claim shelves; none does. The line reads `blocking-impact.json`, the record the #4602 count already writes, and adds no new count, cause or order.

Caveats, not hidden: (1) The list is the holder's whole shelving (the rows behind every row and pull request it holds), not only the rows behind `row`; a holder holding two rows hears one number. (2) A record more than `MAX_TICK_GAP_MS` (10 minutes) old prints nothing rather than a stale count. (3) A freshly claimed row has nothing shelved until the next tick sees its Region, so the FIRST order is usually silent and the line arrives on later wakes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
