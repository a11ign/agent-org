Model routing now decides on the provider's probabilities against thresholds scaled to what a wrong route costs, and no longer discards an answer for a confidence floor. A binary question's confidence is `(p_max - 1/n) / (1 - 1/n)`, so the floor on a yes/no demanded p >= 0.85 and "80% mechanical" was thrown away as not given; a Score split over two adjacent levels that both qualify for Sonnet/medium had a low confidence too. Of the provider's routes in the decision log, 2 went to Haiku/high, 17 to Sonnet/medium and 59 to Sonnet/high.

Closes a11ign/a11ign#4875

## What changes, and why

- **The decision record keeps every question's full `probabilities`** (`decision-provider.ts`). `Answer.probabilities` is the provider's whole distribution, by option for a choice and by the 1..5 level for a score (the API's zero-based positions moved onto the scale `value` is on), kept whether or not the floor replaced the value. A distribution is kept only when this question could have it: an unknown key, a value outside [0, 1] or a total over 1.05 drops it whole, and an empty record is "not given", never a distribution of zeros. `value`, `fellBack` and `confidence` are untouched, so the window (`adjustWindow`) and `provider-confidence.ts` read what they read before.
- **`composeRoute` reads probabilities against named constants** (`engineer-route.ts`). Haiku/high: P(mechanical = yes) >= `HAIKU_MIN_P_MECHANICAL` 0.65 and P(score <= 2) >= `HAIKU_MIN_P_SCORE` 0.6. Sonnet/medium: P(score <= 3) >= `MEDIUM_MIN_P_SCORE` 0.6 and P(subsystems = yes) < `MEDIUM_MAX_P_SUBSYSTEMS` 0.5. Otherwise Sonnet/high. `P(score <= k)` is the sum of levels 1..k, rounded to 6 places so an exact 0.6 is not 0.5999999999999999.
- **Two rules #4764 had stay as they were, now on probabilities:** P(debugging = yes) >= `HOLD_AT_P_DEBUGGING` 0.5 holds a row at Sonnet/high, and a mechanical row whose score was NOT given may still go to Haiku when its Region is 1 to 3 files. A question not given never lowers a row.
- **The absolute refusals are untouched:** `.github/workflows/`, no Acceptance command, `lane:ceo`, `needs:chairman` are decided before the provider is asked, and no provider is the deterministic fallback as today. Both are tested at probability 0.975.
- **The route's line prints what it was composed from,** for example `route haiku/high window 130k via jev (the provider's probabilities: P(mechanical=yes)=0.800, P(subsystems=yes)=0.100, P(debugging=yes)=0.050, P(score<=2)=0.700, P(score<=3)=0.900)`; a distribution not given says why, in `reason`.
- **Not here: the daily guard (the row's item 4).** It needs the first-pass reading by tier, which is `src/trace/haiku-tier-report.ts`, and a poster; neither is in this row's Region, and `recordRouteOutcome` has no caller today, so the decision log carries no first-pass outcomes to read. Posted on the row for `product-manager`.

## Platform first, deleting first

platform: n/a (no part of GitHub, systemd or git turns a model's distribution into a route; this is this tool's own decision). Net lines: positive, and the 0.7-floor discard of a routing answer is gone from `routeOnly`.

## How you verified it

```
$ npx rstest run --config scripts/rstest/rstest.config.ts src/engineer-route.test.ts
VERDICT pass: 51 tests in 1 file
$ npx tsc --noEmit -p tsconfig.json     # no error in engineer-route* or decision-provider*; only the pre-existing mjs-ratchet.test.ts errors
```

The neighbours that read `Answer` pass unchanged: `decision-provider` 20, `provider-confidence` 14, `triage-provider` 21, `route-accuracy` 18, `engineer-escalation` 37, `ci-failure-class` 13, `class-match` 31, `duplicate-row` 15, `review-depth` 8.

Done-when 1, each by name in `src/engineer-route.test.ts`: (a) a 0.8-mechanical row with P(score <= 2) of 0.7 routes to `haiku/high` end to end, through `decide`; (b) a score split 0.45 at level 2 and 0.4 at level 3 routes to `sonnet/medium`, and the same split on a mechanical row is not Haiku; (c) a row with P(mechanical) 0.5 does not route to Haiku; (d) each refusal holds at probability 0.975, with the provider never called; (e) the decision record carries every question's probabilities, floored or not.

## Mutation

Each applied to the source, the test file run, and the source restored byte-identical (`filecmp`):

- Haiku never fires -> 16 red; Haiku ignores P(mechanical) -> 7 red; the score read per level and not summed -> 13 red.
- Sonnet/medium never fires -> 11 red; medium ignores subsystems -> 4 red.
- Debugging never holds -> 5 red; debugging always holds -> 21 red.
- The refusals never refuse -> 4 red; the refusals always refuse -> 31 red.
- The floor discards again (a floored answer keeps no distribution) -> 7 red; no answer keeps a distribution -> 18 red.
- Score keys left zero-based -> 7 red; a total over 1 kept -> 1 red; an empty record taken as a distribution -> 4 red.

Acceptance: `bash -c 'cd ~/repos/agent-org && npx rstest run src/engineer-route.test.ts'`

## Anything a reviewer should be sceptical of

- **The row's command runs the primary checkout**, which does not hold this change until it merges; the same file was run from the worktree with its own config (above). Both are `rstest`.
- **The thresholds are the chairman's starting values, not calibrated.** The decision log has had no probabilities until now, so there is nothing to calibrate against; the first daily reading is the verify row's.
- **The window still reads the floor.** `adjustWindow` and `provider-confidence.ts` use `value`/`fellBack`, so a routing answer under the floor is still reported there as "under floor" while the route used it. That is left alone on purpose; moving them is a separate row.
- **Open-check:** `grep -cE 'route haiku/high via jev' ~/.cache/a11ign/decisions` prints 0 because the line carries `window <w>` between them; with that allowed for, 2 of 78 provider routes are Haiku/high. A reading at a moment of a log that grows.
