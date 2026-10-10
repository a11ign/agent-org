The provider's confidence is read for the first time: `src/provider-confidence.ts` turns the decision log into one row per use and question, with the decisions asked, the share the floor held back, the fall-backs for any other reason counted apart, and the mean and median confidence, and a CLI prints it. Before this, `row-4742`'s `score` at 0.61 and `row-4739`'s `subsystems` at 0.46 were found by reading the log by eye.

Closes a11ign/a11ign#4748

## What changes, and why

- **`confidenceReading(lines, { now, windowMs, declaredFloor? })` (new, pure).** A string is a raw log line, anything else is a line already parsed. Over `[now - windowMs, now]` of each decision's `at`, for each use and question: `asked`, `underFloor`, `otherFallback`, `answered`, the share, the mean and the median.
- **Under the floor is told from every other fall-back by SHAPE, not by wording.** `settle` keeps the provider's own answer (`asked`) and its `confidence` when the floor replaced it; a 422, a refusal or a timeout carries neither. So a fall-back with a confidence and an `asked` is under the floor, and the rest is `otherFallback`. The floor beside a row is read off the latest under-floor answer's reason (`under the floor 0.7`); a row where nothing fell under it shows the host's declared floor marked `(declared)`, else `not known`.
- **A line it cannot read is counted and named by position** (not JSON, not an object, a decision whose answers are not the shape `decision-provider` writes). A blank line and a `recordOutcome` line are understood and are neither. The provider absent is the empty reading, `no provider decisions in the window`.
- **The CLI** takes `--since 24h` and `--since=24h` (m, h or d; default a day) and `--log=<path>` (default: beside this host's wake ledger). A window it cannot read exits 2 `CANNOT ASK`; an absent log is the empty reading; any other read failure is not reported as one. The host modules are imported when the CLI needs them, so the reading and its test need no `AGENT_ORG_HOST`.
- **Not here:** posting it daily. That is the next row (an announcement once the Telegram split is live, #4742 to #4747; a comment on #4627 until then).

## Platform first, deleting first

platform: n/a (nothing in GitHub, systemd or git counts a provider's confidence; the log is this tool's own). Net lines: positive, a new module and its test; nothing it replaces.

## How you verified it

```
$ npx rstest run --config scripts/rstest/rstest.config.ts src/provider-confidence.test.ts      # AGENT_ORG_HOST unset
VERDICT pass: 13 tests in 1 file
$ npx tsc --noEmit -p tsconfig.json     # no error in provider-confidence*; only the pre-existing mjs-ratchet.test.ts missing-module errors
```

The whole suite with `AGENT_ORG_HOST` set: 34 failed of 8062, in 12 files. **The same suite with these two files moved aside fails the same 34 of 8049, identical test names**, so none is this diff's (the set the #4740 PR recorded too).

The live CLI over `~/.cache/a11ign/decisions` (read-only, 88 decisions in the 24 hours to 2026-10-10T07:54Z):

```
use            question    asked  under floor  share  other fallback  answered  mean  median  floor
model-routing  covered     88     0            0%     70              18        1.00  1.00    0.7 (declared)
model-routing  debugging   88     0            0%     70              18        0.93  0.96    0.7 (declared)
model-routing  mechanical  88     3            3%     70              18        0.76  0.87    0.7
model-routing  score       88     12           14%    70              18        0.61  0.63    0.7
model-routing  subsystems  88     9            10%    70              18        0.70  0.72    0.7
```

**What it shows, as a reading and not a diagnosis:** 70 of the 88 decisions have every answer in the other-fallback column (the 422 the log records), so 18 decisions answered. Of those 18, `score` was held back 12 times, `subsystems` 9 and `mechanical` 3: `score` is the question the provider is least sure of.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/provider-confidence.test.ts`

Mutation: every fall-back counted as under the floor -> 3 red (the 422 split, the question that only 422s, the table); nothing ever under the floor -> 4 red; no lower window edge -> 2 red; no upper window edge -> 1 red; an unreadable line dropped silently -> 3 red; the median taken as the mean -> 1 red; an outcome line read as unreadable -> 1 red. Each restored byte-identical (`diff`).

## Anything a reviewer should be sceptical of

- The row's command is `cd ~/repos/agent-org && ...`; that path holds a release older than this change, so the command here is run from the worktree.
- The `answered` 18 above is a reading at a moment of a log that grows; re-run for the number.
- Under the floor is decided by the answer's shape, so a future fall-back that also carries a confidence and an `asked` would be counted under the floor. `settle` is the one writer today; a test that pinned its output against this reader would be a later row.
