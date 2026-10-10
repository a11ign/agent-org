`src/route-outcome.ts` names a closed routed row's outcome from a fixed vocabulary (`routeOutcomeOf`) and appends it once per row, only for a row the decision log routed with the `model-routing` use on (`recordClosedRow`), so a floor has results to be tuned from (a11ign/a11ign#4627 use 4, agent-org#687). **This is the row's items 1 and 2, which is all the row asks for since `product-manager`'s ruling (b) of 2026-10-10T20:00Z. The caller is a host-side pass and its own row (a11ign#4759), and the live count of outcome lines is that row's Done-when, not this one's**: see the last section.

Acceptance:
```bash
bash -c 'cd /home/agent/repos/wt-agent-org-687 && grep -q "second close-out of the row writes nothing" src/route-outcome.test.ts && npx rstest run --config scripts/rstest/rstest.config.ts src/route-outcome.test.ts'
```

Run in this branch's tree with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json` (without it the report module this one imports refuses at the project declaration, as it does for every test that reaches `project-identity`). Printed: `VERDICT pass: 15 tests in 1 file`. The test pins: each vocabulary string from its facts and its neighbour one fact away; a row with no route line writing nothing, log byte-identical; a second close-out writing nothing; the provider absent (no log, no log path, a log with no route for the row) leaving the log byte-identical and not creating it; the use switched off (three ways) writing nothing; and the line written being the one `windowReadings` reads as the row's outcome; and two close-outs of one row at the same instant leaving ONE outcome (the first test lands the rival between the holder's read and its append, the second lands it before the lock), a lock left behind stopping that row loudly and no other, and no lock left in the log's directory.

The routed rows in the test are routed by the real `routeEngineer`, so the route line the writer looks for is the one production writes.

Mutation (measured on the final files, 15 tests, each restored with `cp` from a copy and `cmp` identical afterwards):
- the route-line requirement removed: 4 of 15 red (no route line writes nothing; another row's line is not this row's; the provider absent; and the directory-untouched test, because the unrouted row would then write).
- the once-check removed: 3 of 15 red (the second-close-out test, the rival-landed-before-the-lock test, the directory test).
- the switch check removed, so the use is never off: 1 of 15 red, the switched-off test alone.
- the switch check replaced by `return null`, so it never writes: 11 of 15 red, every test that expects a line.
- an absent log reported as a fault on the diagnostic: 1 of 15 red, the provider-absent test alone. (The first form of this mutant, "an absent log proceeds to write", was EQUIVALENT: the route-line requirement already leaves an absent log uncreated, so that branch carries only the quietness, which the second form pins.)
- unreadable counts accepted: 2 of 15 red, the count test and the unreadable-facts test.
- `escalated` ignored: 2 of 15 red, the vocabulary test and the each-string-is-written test.
- first pass copied and wrong (`rejectedReviews <= 1`): 3 of 15 red, those two and the "first pass is the report's definition" test.
- the lock not exclusive (`"wx"` to `"w"`): 2 of 15 red, the rival-while-held test and the lock-left-behind test.
- no re-check inside the lock: 1 of 15 red, the rival-landed-before-the-lock test alone.
- the read inside the lock reusing the first read: 2 of 15 red, both rival tests.
- the lock never removed: 2 of 15 red, the rival-while-held test and the no-lock-left test.

Typecheck: `npx tsc --noEmit -p tsconfig.json` reports no error in either file; its only two errors are in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` is not resolvable in this tree), untouched here.

Whole suite in this tree (`rstest run`, `AGENT_ORG_HOST` as above): `VERDICT fail: 32 of 8729 tests failed in 486 files`, all in 11 files under `src/packaging` (milestone-clock, row-file, public-claim, auto-arm-token and others, which read the ambient project's tracker and workflows). Each of the 11 was run on its own with and without these two files and gave the same verdict (7+4+8+5+2+2+1+1+1+1 = 32, and `mjs-ratchet`'s file that does not load), so none is caused by this change. They are not fixed here: they are not in this row's Region.

## What this does not do, and why (measured; the row's Change 3 and Done-when 2 now say the same)

The row first said `close-rows-for-merged-pr.ts` calls the writer when it closes a row. It cannot put a line in the live log, for two reasons, both read from the tree:

1. **It runs where the log is not.** The only automated invocation is `closeRows` in the tracker's `.github/workflows/trunk.yml`, `runs-on: ubuntu-latest`. The decision log is `~/.cache/a11ign/decisions` on the host. On the runner that path does not exist, so the writer finds no route line and writes nothing, quietly, as the provider-optional ruling requires.
2. **It is not the path that runs.** That job runs `agent-org close-rows-sweep --window=60`, whose `closeOnePr` has its own close loop and never calls `applyClosurePlan`; `close-rows-for-merged-pr.ts`'s `main()` runs only on a `workflow_dispatch` with a `pr` input.

So that file is not touched here, and `recordClosedRow` has no caller in this pull request. That is the row as amended (ruling (b), on the row): the caller is host-side, where the log, the trace store and the closed row are all readable, and it is filed as its own row with an edge to this one (a11ign#4759). Until it lands the live log keeps 0 outcome lines of this kind (measured 2026-10-10: 417 lines with an `outcome`, 0 of `merged-first-pass`/`not-first-pass`), and a11ign#4756's wait still ends in an empty join; this pull request does not claim otherwise.

## Rebased onto `cf26deec`

`RowMeasures` gained a required `effort` (agent-org#469) after this was first written. The one-row summary passed to `summarise` names the report's own `EFFORT_UNKNOWN` (no turns were read, and `effort` only groups rows in the report; first pass does not read it). The tests passed again at that point and the typecheck is back to the two `mjs-ratchet` errors above.

## Review of `7c3a3522` (reviewer-agent-org-740, NOT CONVINCED): the once-per-row write was not atomic

True, and my comment claiming "the two would agree" was wrong: two close-outs holding different facts would have appended different outcomes, and the report keeps the LAST one of a row. `recordRouteOutcome` is a plain append and outside this row's Region, so the pair of read and append is made one step in `recordClosedRow`: an exclusive per-row lock file (`<log>.outcome-<row>.lock`, `wx`), held across a second read and the append, released in a `finally`. A close-out that finds it held writes nothing and says so.

Its limit, stated: a process killed between taking the lock and releasing it leaves the file, and that row gets no outcome until it is removed (the diagnostic names it). That is the fail-closed side, chosen over a lock that is stolen by age, because a steal is itself a race that ends in two writers. A different caller that appends to the log through `recordRouteOutcome` directly, not through `recordClosedRow`, is not guarded by this lock; there is none today.
