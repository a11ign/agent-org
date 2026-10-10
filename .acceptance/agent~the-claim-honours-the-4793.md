The claim honours the chairman yield: a `priority:chairman` row is not refused by B4 for a holder that is not itself a chairman row, so the row the gate offers is the row the claim accepts (a11ign/a11ign#4793, following a11ign/a11ign#4524). `sessionEligibility` (new; `sessionEligibilityReason` is its `reason`) asks B4's two halves as before and, only when they refuse, reads whether the chairman labelled the row, with the gate's own `readChairmanPriority`. A chairman row is then compared with the chairman holders alone, so two chairman rows still exclude each other. A claim that goes ahead names the holders it walked past, on stderr and in a comment on the row.

Closes a11ign/a11ign#4793

## What changes, and why

- **`src/row-claim.ts`.** `b4Refusal` is the old body of `sessionEligibilityReason` (the pull-request half, then the claimed-row half), taking an optional `only` set so the same code answers "over every holder" and "over the chairman holders". `chairmanYield` runs after a refusal. `lookupChairmanRows` lists the open `priority:chairman` rows of the tracker and verifies each with `readChairmanPriority`; it fills the `repos/{owner}/{repo}` placeholder with the tracker, since `gh` would fill it from the working directory. `walkedPastNote` is the comment, posted through the `blockedByNote` path a `--blocked-by` exception already uses.
- **Why the label is read by the claim and not passed in.** The row says so (Change 4), and the gate reads the VERIFIED set, never the bare label: a label somebody else added is ignored there, so it must be ignored here, or the claim would accept what the gate refused to offer.
- **Not changed.** `reportB4` (`row-claim check`) still prints B4's refusal for a chairman row: it takes its reads by injection and has no tracker history to ask. Named below.

## How you verified it

`AGENT_ORG_HOST` must be set for the neighbouring files (unset, they report `0 of 0 tests`, which is not a verdict); the new file sets its own project.

```
$ npx rstest run --config scripts/rstest/rstest.config.ts src/row-claim-chairman-yield.test.ts
VERDICT pass: 15 tests in 1 file
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/row-claim src/claimed-region-overlap.test.ts src/packaging/row-claim src/packaging/multi-board-claim.test.ts src/sweep-window.test.ts src/work-gate
VERDICT pass: 886 tests in 54 files
$ npx tsc --noEmit -p tsconfig.json     # only the two pre-existing mjs-ratchet.test.ts errors
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts     # whole suite
VERDICT fail: 34 of 8334 tests failed in 456 files
```

The 34 failures are in 12 files (`mjs-ratchet`, `board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock*`, `pr-template-acceptance`, `public-claim`, `row-file*`, `tick-heartbeat-is-written`, `wake-engineer-brief`), and none reads a claim. Measured: the same 12 files on a detached `origin/main` (`ef57675`) give `34 of 362 tests failed in 12 files`, so the set is identical with and without this change.

Acceptance: `cd /home/agent/repos/agent-org-wt-4793 && npx rstest run --config scripts/rstest/rstest.config.ts src/row-claim-chairman-yield.test.ts`

Mutation: the yield never fires (`chairmanYield` returns the refusal) -> 5 red, the claiming cases (1), (2), (6)'s control, (8) and (9); the yield always fires (membership and the chairman holders ignored) -> 10 red, every refusal case and control; the chairman holders not asked again -> 4 red, (3), (4), (5) and (6)'s unreadable list; the label not verified (every labelled row is the chairman's) -> 2 red, both (7); the note not wired into `preWriteChecks` -> 1 red, (9). Each file was restored from a copy and diffed byte-identical.

## Anything a reviewer should be sceptical of

- **`row-claim check` (`reportB4`) still reads "B4 REFUSES THIS CLAIM" for a chairman row the claim now accepts.** The prediction and the claim disagree on that one row until `reportB4` is given the same read. Filed as a11ign/a11ign#4799, not folded here, because its Region is a read-only report with injected seams and the Change names the claim.
- **The gate's `chairmanRows` is the verified set of READY rows**, and a claimed holder is no longer `ready`, so the gate's "TWO CHAIRMAN ROWS STILL EXCLUDE EACH OTHER" cannot see a claimed chairman holder at all. This claim reads every OPEN row with the label, so it does see one. Measured from the code (`main` passes `readyRows` to `offerHierarchyNow`), not from a run; the gate's side is a11ign/a11ign#4800.
- **Three reads are added, and only after B4 has refused:** the tracker's `priority:chairman` list and one `events` read per labelled row. A claim that overlaps nothing makes none (test 8).
- **A holder's `Closes` is read from the pull request's body**, as B4 already does; a chairman row's pull request that does not declare it reads as a plain holder and is walked past.
