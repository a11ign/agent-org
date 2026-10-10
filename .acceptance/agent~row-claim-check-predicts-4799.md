`row-claim check` predicts the chairman's yield: `reportB4` no longer prints `B4 REFUSES THIS CLAIM` for a `priority:chairman` row the claim now lets past a holder that is not itself a chairman row (a11ign/a11ign#4799, following a11ign/a11ign#4793). It prints `B4: yields to the chairman's row (a11ign#4793); would walk past <holders>` instead, by the claim's own decision (`chairmanYieldVerdict`) over the reads `check` already made.

Closes a11ign/a11ign#4799

## What changes, and why

- **`src/row-claim.ts`.** `chairmanYield` is split: `chairmanYieldVerdict` is the decision (is the row the chairman's, is B4 still refused over the chairman holders alone, who is walked past) and `chairmanYield` keeps the stderr line the claim writes. `B4Ask` gains `made`, the reads `check` has already made (the claimed rows, the sweep freeze over the windows it read, and a lazy `chairmanRows`); `b4Refusal`, `claimedRegionsReason` and `holdersWalkedPast` read through it when it is present and are otherwise unchanged. `reportB4` reads the claimed half once (`readClaimedHalf`), asks `chairmanYieldLine`, and prints its line in place of the verdict when it yields. Everything else it printed is untouched.
- **Why `check` calls the claim's code and not a second reading.** The row says so (Change 1). `check` already composed B4 from the same pure verdicts (`fileOverlapReason`, `claimedRegionsVerdict`, `sweepFreezeOf`); the yield is the one place it would have needed a rule of its own, and a rule of its own is how it came to disagree.
- **Not written by `check`.** The claim's freeze read posts the stalled and overrun notices; `check` asks `sweepFreezeOf` over a list it read and posts nothing, so it stays read-only.

## How you verified it

```
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/row-claim-check-chairman-yield.test.ts
VERDICT pass: 10 tests in 1 file
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/row-claim*.test.ts src/claimed-region-overlap.test.ts src/sweep-window.test.ts src/packaging/multi-board-claim.test.ts
VERDICT pass: 155 tests in 8 files
$ npx tsc --noEmit -p tsconfig.json     # only the two pre-existing mjs-ratchet.test.ts errors (`@a11ign/toolchain` is not installed in the worktree)
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts     # whole suite, here and on a detached origin/main (8ccca28a)
here: VERDICT fail: 34 of 8382 tests failed in 460 files
base: VERDICT fail: 34 of 8372 tests failed in 459 files
```

Measured: with `A11Y_RSTEST_FULL_REPORT=1` the two failing-test lists are byte-identical (35 lines each, `comm` of the sorted names empty both ways), and this change adds exactly the 10 tests and the 1 file. The 34 failures are in files that read no claim (`mjs-ratchet`, `board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock*`, `pr-template-acceptance`, `public-claim`, and the rest) and were red before.

Acceptance: `cd /home/agent/repos/agent-org-wt-4799 && npx rstest run --config scripts/rstest/rstest.config.ts src/row-claim-check-chairman-yield.test.ts`

Mutation: the unmodified `row-claim.ts` (origin/main's) -> 4 red, (1), (2), (5)'s "asked only after a refusal" and (6); the yield never fires (`chairmanYieldLine` returns null) -> the same 4 red; the yield always fires on a refusal (the chairman decision dropped) -> 7 red, every refusal case and control; the sweep freeze not asked in `check`'s ask -> 1 red, (4)'s sweep case (and it was 0 red until that case gained a plain pull request that also overlaps: without one the freeze is B4's only refusal and a `check` that ignored it printed today's refusal for want of anything to yield over); the default chairman read reaching `gh` when other reads were injected -> 1 red, (5). Each file was restored from a copy and diffed byte-identical.

## Anything a reviewer should be sceptical of

- **`check` prints ONE line for a yield**, replacing both halves' sentences (and keeping the empty-file-list NOTE). A half that was clean no longer says so. That is a choice of wording, not of verdict; the verdict is the claim's, pinned row by row in (6).
- **`check` with some reads injected and no `chairmanRows` is today's refusal**, not a read. That is deliberate (a test of `check` must never reach `gh`, as with `sweeps`), and it means a caller that injects `mine`/`others`/`claimed` and expects the yield must inject `chairmanRows` too. The real `row-claim check` injects nothing and reads the history, after a refusal only.
- **The yield line says `a11ign#4793` literally**, as the row's Change 1 words it, not the tracker the row lives in.
- **`B4Ask.otherPrFiles` is now typed by what `fileOverlapReason` accepts**, not by `lookupOpenPrFiles`'s return: `check`'s injected `others` does not carry `held`, and the claim never needed it there.
