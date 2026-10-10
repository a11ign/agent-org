The engineer route sets the `--autocompact` window as well as the model and effort (a11ign/a11ign#4738, #4627 use 1b). `routeEngineer` sizes it from the Region (files and repositories) with no provider needed, lets the provider's `score` and `subsystems` answers move it one rung only when each was given at or over the confidence floor and `model-routing-window` is on, holds a Haiku route to its ceiling whatever either says, and prints it on the outcome line as `route <route> window <n>k (<basis>) via <via> (<why>)`. `node src/engineer-route.ts [--record]` prints window against compactions, cost and outcome per route and records `window too small`.

Closes a11ign/a11ign#4738

## What changes, and why

- **`worker-profile.ts`.** The rungs (`SONNET_WINDOW_RUNGS`: 200k, 400k, 600k), `windowCeiling`/`clampWindow` (the one place the Haiku ceiling bounds a window) and `ordinaryTierProfile` (a Sonnet/high row at a larger window needs a profile, where it had `null`). The ordinary window is the floor of every Sonnet route: below it is #2717's thrash.
- **`engineer-route.ts`, the fallback.** `fallbackWindow` from `regionSize`: `LARGE_ROW_FILES` (8, derived: the working room of the ordinary window over a ~12k-token file read) or two repositories give 400k; `LARGEST_ROW_FILES` (16, twice that) or three repositories give 600k. The cut-offs are starting values, to be tuned from the log the report prints.
- **`engineer-route.ts`, the provider.** `adjustWindow`: one rung UP when `subsystems` is yes or the score is at least 4, one rung DOWN only when both are given and say smaller, never below the ordinary window. An answer that fell back is `null` and counts for nothing, and `windowWhy` says which answer was left out and why. The provider is asked once, as before: the window has its own key, `model-routing-window`, read from `.agent-org/decisions.json` beside the router's.
- **The line and the log.** `route sonnet/high window 400k (the Region names files=9 repositories=1) via jev (<why>)`. `why` is unchanged, so the work tick's journal line and the outcome line still print the same reason. `windowReadings`, `windowReportLines` and the `node src/engineer-route.ts` reader join the window on that line with the trace store's compactions and cost; `--record` appends `window too small: <n> compactions at <window>` for a row over `WINDOW_TOO_SMALL_COMPACTIONS` (2).

## How you verified it

`AGENT_ORG_HOST` must be set (unset, the files report `0 of 0 tests`, which is not a verdict); I set it to the a11y-witness checkout's `.agent-org/host.json`.

```
$ npx rstest run --config scripts/rstest/rstest.config.* src/engineer-route.test.ts src/worker-profile.test.ts
VERDICT pass: 32 tests in 2 files        # engineer-route.test.ts was 22 before; 7 new there, 3 in the new worker-profile.test.ts
$ npx tsc --noEmit -p .                  # only the two pre-existing mjs-ratchet.test.ts missing-module errors
$ node src/engineer-route.ts --log <2-line log> --store <empty>     # prints one line per route and window, exit 0
```

The affected set (`--changed=origin/main`) shows 31 failures in 9 files (`board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock*`, `row-file*`, `tick-heartbeat-is-written`, `wake-engineer-brief`). The last two fail 6 of 24 on a detached `origin/main` (`d20a41e`) and 6 of 24 here; none reads the route.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/engineer-route.test.ts src/worker-profile.test.ts`

Mutation: the Region's size ignored (`fallbackWindow` always the ordinary rung) -> 7 red; the provider's answers never move it -> 1 red (the provider case); the confidence floor ignored (a fallen-back `subsystems` still counts) -> 1 red (the same case, its under-the-floor control); `clampWindow` removed -> 5 red (the Haiku cases, the clamp unit test and the pinned outcome lines); outcome line without the window -> 6 red; the window's own switch ignored -> 4 red. Each file was restored from a copy and diffed byte-identical.

## Anything a reviewer should be sceptical of

- **The window switch is not a `DecisionUse`.** `decision-provider.ts` is outside this row's Region, so `model-routing-window` is read here with `readSwitches`, and a typed `DECISION_USES` entry is the cleaner home. The provider is not asked a second time, so this is a switch and not a use.
- **Nothing flips it.** The a11y-witness `.agent-org/decisions.json` holds only `"model-routing": true`, so until `ceo` adds `"model-routing-window": true` the window is the Region's alone. That file is not this row's Region either.
- **Haiku's window is 130k, not 95k.** `--autocompact` compacts about 35k below its value, so the 95k trigger is a 130k window (`HAIKU_AUTOCOMPACT_WINDOW_TOKENS`); the line prints 130k.
- **The work tick's journal line (`wake.ts`) does not print the window**, which is outside the Region; the outcome line does.
- **Outcomes are joined only where the log holds one.** `recordRouteOutcome` has no caller in production, so the `outcomes` column reads `no outcome recorded` for every row today.
- **Files and repositories are the only Region reading.** A row whose Region names few files and needs a great deal of reading (a monolith) takes the ordinary window unless the provider is on and says so.
