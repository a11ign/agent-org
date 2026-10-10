Wake triage composes on P(yes) of the four questions that decide, not on five answers each over a flat 0.7 floor, so an informational order digests at p = 0.75 (a11ign#4889).

Closes a11ign#4889

## What changes, and why

- **Probabilities are kept and read.** `triageOrder` returns `probabilities` (P(yes) per question: the provider's distribution, else derived from its `choice` and `confidence` by `p_max = 0.5 + confidence / 2`, else `null` = not given, never zero). The floored `value` no longer decides a route.
- **`compose` digests** when P(informational only) >= 0.65, P(asks this seat) < 0.3, P(red main) < 0.2 and P(chairman direction) < 0.2; otherwise it wakes. A probability not given wakes. `repeat` digests on the state's own delivery inside the hour plus P(repeat) >= 0.5, with the two guards clear, and is never a veto.
- **Deleted:** the per-question floors (`REPEAT_FLOOR`, `WAKE_GUARD_FLOOR`) and the "one `asks-this-seat=no` digests" rule of #718, both made moot because the floor no longer gates composition.
- The thresholds are the row's starting values, exported constants, to be calibrated from the kept probabilities.

## How you verified it

Run with `AGENT_ORG_HOST` set to a checkout holding `.agent-org/project.json` (this worktree has none). The row's literal command `npx rstest run src/triage-provider.test.ts` reports "No test suites found" without `--config scripts/rstest/rstest.config.ts` (the package's own `test` script); with it, and via `node --import tsx --test`, the suites pass.

Done-when 1: p = 0.75 informational digests; asks-the-seat at p = 0.6 wakes; a red main wakes at p of 0.2, 0.5, 0.9 and 1 with everything else confident; `repeat` at any p does not force a wake.

Acceptance: `node --import tsx --test src/triage-provider.test.ts src/triage-route.test.ts src/decision-provider.test.ts`

Mutation: six mutants, each killed by named tests: the guard comparison never firing (8 fail), always firing (16 fail), the informational test always passing (3) and never passing (14), `repeat` ignoring its probability (3), a null probability read as given (2). Source restored with `cp` and `diff`ed identical.

## Anything a reviewer should be sceptical of

- **`src/triage-route.test.ts` is touched, outside the row's two-file Region**: two of its assertions encoded the floor-decides behaviour this row removes (0.89 delivers; `asks-this-seat=no` alone digests). Nothing else of it changed.
- **A host's `minConfidence` no longer governs the route**; it still floors `value`, which the log and `answers` carry.
- **Done-when 2 (the next day's digest share and its digested-then-needed-action count) is the separate verify row**, not this one.
