Model routing through the provider no longer pins every row to Sonnet/high: the `covered` gate is gone, the answers are recomposed so a mechanical row reaches Haiku/high and a small single-subsystem row Sonnet/medium, each provider route logs the route the fallback would have taken, and a guard raises a ledger incident when the provider's routes average dearer than the fallback's.

Closes a11ign/a11ign#4764

## What changes, and why

- **`covered` is removed (change 1).** It was answered `no` on 55 of 55 logged provider decisions, so a gate on it could only ever say Sonnet/high. "The Acceptance is a command" is a fact of the row's text, which `whyHeld` already reads (no command, no route lowered), so there is nothing left for a provider to answer. `QUESTIONS` is four questions; `Answers` has no `covered`.
- **`composeRoute(answers, { regionFiles })` (change 2).** `debugging` yes holds a row at Sonnet/high. Otherwise: **Haiku/high** for `mechanical` and `score <= 2`, or `mechanical` with the score NOT given and a Region of 1 to 3 files (a Region that names nothing is unread, not small); **Sonnet/medium** for `score <= 3` and `subsystems != yes` (not given passes); everything else Sonnet/high. The Haiku switch and its refusals are still asked of the same code `tier:haiku` uses.
- **The fallback's would-be route is logged beside each provider route, and a guard reads it (change 4).** A `via jev` outcome line ends `[fallback would be <route>]`. After each one, `routeCostReading` takes the last 20 lines that carry it and compares mean rungs (`haiku/high` 1, `sonnet/medium` 2, `sonnet/high` 3: an ORDER, not dollars); strictly dearer appends a `route-costlier-than-fallback` event to the failure ledger beside the log, one ref per UTC day. Fewer than 20 comparisons says nothing, and a line written before this change is not a comparison. It never throws: an unreadable log is reported on the diagnostic and the route still comes back.
- **`score` and `subsystems` carry structure and examples (change 3).** Each score level is a summary and its signals, each subsystems option is `what`, `not for` and examples, and every example is a row of ours with the merged diff that settled it (`git diff --numstat` of the merge commit). It is rendered into the existing string criteria.

## Platform first, deleting first

platform: n/a (nothing in GitHub or systemd compares a model route with a rule). Net lines: positive: a guard, the examples' data and their tests; one question and its gate are deleted.

## What was NOT done, and why

- **Structured `criteria` objects on the wire (`what`/`not_for`/`examples` as fields).** `wire()` is `decision-provider.ts`, outside this Region, and a shape the API refuses is an HTTP 422 for every question at once, which this test file's own `violation` control shows. The structure is carried as text inside the strings the API already takes. #4752 is that row.
- **TypeSafe's own guidance pages were not read here** (its skill is installed for #4752 alone, as ruled 2026-10-09); the method is as #4627's 07:45Z direction states it.
- **"Outcome known" is merged and what it changed.** First-pass CI is in no log this module can read, so an example says how big the merged diff was, not that it merged first pass.
- **Whether `score` and `subsystems` fall under the floor less is NOT measured here.** The baseline, read from the decision log (55 provider decisions, 2026-10-10): `score` under the floor on 34, `subsystems` on 30, `mechanical` 9, `debugging` 8. Done-when 2 is the separate verify row.

## How you verified it

Done-when 2 (a Haiku and a Sonnet/medium route `via jev`, quoted from the live log) is the verify row, after a release; it is not claimed here.

Before the merge with #604 the two files passed 69 tests. After merging `main` with #604 the row's test file and `engineer-escalation.test.ts` pass (77 tests), and the whole suite ends 34 failed of 8200 in 12 files (before the merge: 34 of 8152, the same files) (`board-truth-audit`, `failure-ledger`, `packaging/{auto-arm-token,milestone-clock,milestone-clock-exact-start,pr-template-acceptance,public-claim,row-file,row-file-refuses-duplicate-title,tick-heartbeat-is-written,wake-engineer-brief,mjs-ratchet}`): the same count and file set as the reading recorded on the previous agent-org pull request, none of them importing `engineer-route`, and `failure-ledger.test.ts` fails on the project's own `failure-classes.json` (an `owner-unresolved` entry), not on a key this change writes. That is a reading at a moment, not a claim that main is green.

Acceptance: `bash -c 'cd "$AGENT_ORG_TOOL" 2>/dev/null || cd ~/repos/agent-org; npx rstest run --config scripts/rstest/rstest.config.ts src/engineer-route.test.ts'`

Mutation: the `covered` gate re-added -> 8 red; the medium rule's `subsystems !== true` -> `=== false` -> 2 red; its `score <=` -> `<` -> 5 red; the medium rule removed -> 8 red; the score-not-given Haiku carve-out ignoring the Region's size -> 2 red; `debugging` yes no longer holding -> 4 red; the guard never run -> 2 red; `>` -> `>=` -> 4 red; the guard reading the FIRST 20 not the last -> 1 red; the guard firing below 20 -> 3 red; the would-be route not logged -> 3 red; one event per route instead of per day -> 2 red; after merging #604 (which put `window <label>` into the outcome line), the would-be reader ignoring the window -> 5 red. Each restored byte-identical (`diff` against a copy).

## Anything a reviewer should be sceptical of

- **`mechanical` with a score of at most 2 is Haiku/high whatever `subsystems` says**, as the row's rule 1 is written. The old composition held a subsystems `yes` at Sonnet/high. A mechanical row that spans modules is rare and #4630's escalation recovers a wrong Haiku start, but it is a behaviour change worth a second look.
- **A non-mechanical row whose score was not given stays Sonnet/high**, where the fallback would have said Sonnet/medium for a small row. The row's rule says so and the guard measures exactly this: with the log as it stands (31 of 49 scores not given) it may fire once 20 comparisons exist, which is it working.
- **`debugging` is kept** (a yes holds a row at Sonnet/high); the row's recomposition does not mention it. Not given does NOT hold, to match `subsystems != yes`. No logged decision answered `debugging` yes, so this is untested against live data.
- **The ledger path is derived from the decision log's directory** (`dirname(logPath)/failure-ledger`), the layout `routesForStarts` already builds. A host that puts them apart gets no incident, and no error.
- The row's command is `cd ~/repos/agent-org && ...`; that path is the primary clone, which does not hold this change, so the command here is run from the worktree.
