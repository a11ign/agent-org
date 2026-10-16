An OPEN, unclaimed shared-failure incident row no longer releases the holds of the pull requests it names at 15 minutes (agent-org#1557, from a11ign/a11ign#5580). `standingOf` in `src/ci-failure-class.ts` returned `{ hold: false, why: "expired" }` for any open row older than `HOLD_MAX_MS` without the `in-progress` label, so every held PR's worker was woken at once (the eight 2026-10-12 occurrences: #5228 and #5234, released 15 minutes after each opened, before either closed). The rule now holds an open row's pull requests until the row closes, claimed or not; a CLOSED row still releases at once (`why: "closed"`), and `"expired"` is removed from the release vocabulary. An unclaimed open row past `HOLD_MAX_MS` is named once per tick in the gate log (`incident #N has been open 15 minutes with no claim; its held pull requests wait for it to close, and no worker is woken`). `bodyOf`'s text now says the row's pull requests are HELD until it closes, not that the row "carries no claimable work", so the row and its rule agree.

Acceptance:

```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ci-failure-class.test.ts
```

Two tests were added to `src/ci-failure-class.test.ts`: `#1557 POSITIVE` (an open unclaimed row 16 minutes old naming four red PRs holds all four, wakes none, and is logged) and `#1557 NEGATIVE` (a row closed by its fix releases its four PRs at once, naming the row).

Measured here: the command above printed `VERDICT pass: 34 tests in 1 file` after the change (32 before). Run against the original `HEAD` source, `#1557 POSITIVE` FAILED: four orders went out, each `SHARED-FAILURE HOLD RELEASED (#900: its incident row was not claimed within 15 minutes)`, which is the defect. Mutations, each mutant copied to the scratchpad, run, and restored with a byte-identical `diff`: (1) the closed-row release disabled (never releases a closed row): only `#1557 NEGATIVE` fails; (2) an open row always released: `#1557 POSITIVE` fails, and so does the pre-existing `shared failure -- POSITIVE CONTROL`, because that test's second tick relies on an open row holding, so this mutant is not confined to its own test. `event-drift.test.ts` (the other `standingOf` caller) and the nine other test files that import this module pass: 127 tests in 10 files, including the file above. `pnpm run typecheck` (`tsc --noEmit`) printed no errors. `agent-org` has no `lint` script, so no lint was run.

Decision (fix (a) from the row): the hold waits for the row to close; the bound is the gate log line, not an order to one session. Making the log line an order to the row's owner would need a new order vocabulary in the tick's caller, which is outside this Region; if the owner must be woken rather than logged, that is a new row.

Outside-Region: none. `git diff --stat` touches only `src/ci-failure-class.ts` and `src/ci-failure-class.test.ts`, and the source's net change is +3 lines (17 added, 14 removed): the removed lines are the `young`/`expired` branch and its reason text, the added ones the rule's comment, the bound's log line and its test-visible wording.

platform: nothing reimplemented; this is a rule change in the existing `standingOf` and the existing tick log.

Closes #1557
