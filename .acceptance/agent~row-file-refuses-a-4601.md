`row-file` measures a new row's Region at filing and refuses one that expands to more than 20 files or overlaps more than 5 open rows and pull requests, unless the body carries a `Sweep:` line (a11ign/a11ign#4601, lock-gridlock fix 1 of 4).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.* src/blast-radius.test.ts
```

The row's command is `cd ~/repos/agent-org && npx rstest run --config scripts/rstest/rstest.config.* src/blast-radius.test.ts`. The primary checkout carries the new test only after the merge, so before it that command runs no file; the command above is the same one run in the PR's own tree (`pr-open` runs it in the working tree). `AGENT_ORG_HOST` is set to a11y-witness's `.agent-org/host.json`, which the run needs. Printed:
```
VERDICT pass: 18 tests in 1 file -- full report: A11Y_RSTEST_FULL_REPORT=1
```

Mutation:
- The test file pins 21 refused and 20 files, 6 refused and 5 files, both measured (not zero), and the same body with and without a `Sweep:` line. Each mutant below was applied to `src/blast-radius.ts` (or `src/row-file.ts`), run, and restored byte-identical (`diff` against a copy):
  - files check never fires (`files > 1e9`): 6 of 16 fail, the 21-file, sweep, either-number, failed-read, pure-verdict and wiring tests.
  - files check always fires (`files >= 0`): 6 of 16 fail, including the 20-file control and the no-Region-reads-nothing test.
  - overlap check never fires: 4 of 16 fail, the 6-row, either-number, failed-read and pure-verdict tests.
  - overlap check always fires: 6 of 16 fail, including the 20-file control.
  - `Sweep:` never declared: 2 of 16 fail (the sweep test and the wiring test). Always declared: 9 of 16 fail.
  - the gate not wired in `createIssue` (`if (blast.refusal)` made `if (false)`): 1 of 16 fails, the wiring test, and no pure test.
  - (rework, reviewer at `96f399bc`) truncation ignored (`!prs.some(isTruncated)` dropped from `overlapsComplete`): 2 of 18 fail, the short-PR test and the `ghBlastReads` reproduction; restored byte-identical (`diff` empty).
  Mutants overlap in the tests they break, since several tests exercise one threshold; the two the row asks about (never, always) each break their own threshold's test.

Suite: the whole `agent-org` suite at `origin/main` (`e620e4c`) and on this branch, both with `AGENT_ORG_HOST` set as above: `33 of 7577 tests failed in 408 files` before and `33 of 7593 tests failed in 409 files` after (the 16 are this row's; the rework adds 2 more). The 20 distinct failing test names are the same set in both (`comm -3` of the two is empty), so none is new; they fail on `origin/main` too in this environment.

Done-when 2, run for real from this worktree (`node src/row-file.ts ... --label out-of-release --tracker=agent-org`), body Region `agent-org:src/`:
```
row-file: REFUSING to file -- the Region expands to 697 file(s) (limit 20) and overlaps 50 open row(s) and pull request(s) (limit 5): #4606, #4605, #4603, #4602, #4601, #4582, #4475, #4390, and 42 more. One claim on a Region this wide shelves every row that touches it (lock-gridlock, #4437). Nothing was filed. Either SPLIT the row into bounded rows, one folder each, or DECLARE A SWEEP: add a line `Sweep: <why this change must land as one row>` to the body (#4601).
```
and the same body plus a `Sweep:` line (a real filing as a backlog row with `out-of-release`, agent-org#526, closed at once as not planned):
```
row-file: SWEEP declared -- the Region expands to 697 file(s) (limit 20) and overlaps 50 open row(s) and pull request(s) (limit 5): #4606, #4605, #4603, #4602, #4601, #4582, #4475, #4390, and 42 more.
https://github.com/a11ign/agent-org/issues/526
```
