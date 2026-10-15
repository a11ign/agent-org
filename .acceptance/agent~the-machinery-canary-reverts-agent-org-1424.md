The canary's bar is built from the trailing day, not from one quiet hour (a11ign#5444, agent-org#1424). A zero hour set the bar at 3 (`max(0 × 2, 0 + 3)`), so three ordinary claim refusals reverted `rows.closedUnderOpenHalf`. The bar now takes the higher of the hour and the day's hourly mean; a day less than half recorded is no baseline, and the hour alone stands as before.

Acceptance: `node --test src/org-health.test.ts src/packaging/machinery-canary.test.ts`

Mutation: with the day's coverage threshold removed (`day.coveredMs >= 0`), `#5444 (3b)` fails; with `src/org-health.ts` at HEAD, `#5444 (1)`, `(2)` and `(4)` fail. `org-health.ts` restored byte-identical each time, and all 29 pass.
