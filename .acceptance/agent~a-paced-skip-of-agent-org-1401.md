A tick that SKIPPED the primary's lanes by pacing no longer reads them as refused. The primary's `null` tracker lanes (promotable rows, chairman-blocked rows, open rows) are a skip when `primaryRead` is false, and `outageThisTick`, `claimStallsNow` and the offer line (`offeredByFloor`) now say so: no `OUTAGE:`, no `claim-stall: ... could not be read -- NO claim was evaluated`, and `PRODUCT ROW OFFER NOT READ (share X/Y): the open rows were skipped by pacing this tick` in place of `NO PRODUCT ROW OFFERABLE`. A primary lane that WAS asked and came back `null` is still a refusal, named on PARTIAL (`primaryRefusedLanes` in `src/work-gate/pacing.ts`, handed to `tickLanes` as `primaryRefused`). A refused open-rows read now says gh's reason on stderr (`NOTE: the open rows could not be read (<gh reason>); read as refused`), where it said nothing before.

Acceptance: `node --test src/packaging/gate-graphql-pacing.test.ts` (run from the worktree `/home/agent/repos/wt-agent-org-1401`)

Output:

```
ℹ tests 25
ℹ suites 0
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The four new tests, each with its RED CONTROL beside its positive assertion: `a tick whose primary lanes the pacing SKIPPED reads none of them as refused` (`outageThisTick` with `primaryRead` false is false and true with it true; `claimStallsNow` with `openRowsPaced` true logs no `could not be read -- NO claim was evaluated`, and false logs it); `the offer says PRODUCT ROW OFFER NOT READ for rows the pacing skipped` (paced prints the new line, not read prints `NO PRODUCT ROW OFFERABLE`); `a refused primary lane is named on PARTIAL, and a skipped primary names none`; `primaryRefusedLanes names each primary lane that was asked and came back null`. The fifth, `a refused open-rows read says gh's reason on stderr and still returns null; a read that works says nothing`, fails on the `HEAD` copy of `src/work-gate/reads.ts` (1 failed) and passes with the change.

Mutation (each applied to one guard, the test file run, the file restored from a `cp` backup and checked with `diff`). Each mutant fails exactly one test of the 25:
- `outageThisTick` counts the skipped primary lanes (`const primaryLanes = primaryRead ? [...] : []` made unconditional): 1 failed.
- `claimStallsNow` ignores `openRowsPaced`: 1 failed.
- `offeredByFloor` ignores `paced`: 1 failed.
- `primaryRefusedLanes` names the skipped lanes (`if (!primaryRead) return []` removed): 1 failed.

On `main` the file does not load at all: it imports `primaryRefusedLanes`, which `main` does not export, so the 25 cannot be run there. The behaviour the Acceptance names (the positive and negative controls) is only reachable with this change.

Measured:
- `pnpm run typecheck`: exit 0.
- `node --test src/work-gate-claim-stalled.test.ts src/packaging/work-gate.test.ts src/work-tick-cost.test.ts src/packaging/closed-row-ends-instance.test.ts src/packaging/product-share-once.test.ts`: 607 pass, 37 fail. The same 37 fail, by name, on `fbe40ef5` (`main`'s HEAD before this branch) in a detached worktree, and the same 37 with the `HEAD` copy of `reads.ts`. The failures are verdict and red-order routing tests (`redOrder`, `causeKey`, `session`), not this change.
- `pnpm test` (rstest, the project's own suite), run at `f37a8654`: 115 of 11636 tests fail, in 26 files. The same 115 fail, by name, on `fbe40ef5` in a detached worktree: they are gh rate-limit and 502 refusals, and `live-tree-independence.test.ts`, which needs `tsx` as a host install (`Cannot find module 'tsx/package.json'`; `tsx` is not in `package.json` or `pnpm-lock.yaml`). Not re-run after the stderr change.
- `pnpm run lint` and `pnpm run verify`: this repository has no such scripts (`package.json` has `typecheck` and `test` only). Not run.

Not here, and named:
- Done-when 2, the 19:35:53Z and 19:55:01Z ticks: the primary's open-rows read WAS asked and refused. `readOpenRowsAsListed` in `src/work-gate/reads.ts` returned `null` from a `catch {}` that discarded gh's error, so the journal does not carry a reason for those two ticks, and that reason cannot be recovered from this repository. The fix here stops discarding it: every refused open-rows read now writes gh's reason to stderr. The three primary lanes are named on PARTIAL when refused, as before.
- Done-when 3, the post-release reading (count of `open rows could not be read -- NO claim` on a later flag-on hour, beside `CANNOT ASK` and `rate limit`): pending until a flag-on hour runs on the released build.
- The mixed PARTIAL (`PARTIAL: could not read ... and ...` when a primary lane is refused alongside a paced lane) keeps the #1414 wording, which `gate-graphql-pacing.test.ts` pins.

Closes a11ign/agent-org#1401

🤖 Generated with [Claude Code](https://claude.com/claude-code)
