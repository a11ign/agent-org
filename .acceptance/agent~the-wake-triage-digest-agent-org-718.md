The wake-triage digest share fell from 7.8% to 0.5% because five questions each needed an answer at or over a flat 0.7 and an answer under it took a fallback that wakes: 607 of 609 five-answer asks had one under it, and two were held. This is the whole of a11ign/agent-org#718 (item 2 of a11ign#4627).

Closes a11ign/agent-org#718

## What changes, and why

- **What was said is kept.** The `asked` line carries `said`, per question the provider's raw `value` and `confidence` beside the `answers` that were used, and `triage.reason` when `via` is `none` (HTTP status, timeout, `triage-unavailable`, no provider). `routing()` used to drop `Triage.reason`, so 200 `via: none` orders could not be diagnosed.
- **The digest is reachable on one confident answer.** `compose` holds an order when `asks-this-seat` is `no` (its fallback is `yes`, so `no` means the provider was over its floor), or on `repeat=yes` with a delivery inside the hour in the state, as before. `informational-only` stays a second path. A red main or a chairman direction still wakes first, from the state before anything is asked and from the provider's own `yes` after.
- **Per-question floors**, in `QUESTIONS`: `asks-this-seat` and `informational-only` use the host's `minConfidence` (the answers that can hold an order alone); `repeat` 0.5 (`REPEAT_FLOOR`; `compose` also needs the state's own delivery); `names-red-main` and `names-chairman-direction` 0.3 (`WAKE_GUARD_FLOOR`; under it the fallback is `yes`, which wakes). **These two numbers are a first choice, not a measured one**: the recorded log holds only the weakest confidence per ask (median 0.22 over 620 lines), never a per-question one, so they are tuned from `said` once it has accumulated.
- **The incident is data.** `digestShareByDay` reads the log's `asked` lines per UTC day, `formatDigestShare` prints the table and a `LEDGER INCIDENT` line for a day under 5% over at least 50 asks (`node src/triage-route.ts [--log=<path>]`; the default is the digest log beside the host's wake ledger). A line it cannot read is counted and named, not skipped.

## Platform first, deleting first

platform: n/a (nothing in GitHub, systemd or git composes a route from a provider's answers or reads this log).

The #4875 risk-scaled shape is not on `main` (it edits `decision-provider.ts`, outside this Region), so the floors use the `minConfidence` a `Question` already carries and nothing was added to the seam. Net lines are positive: the reading and the tests. `compose` gained one rule and no function.

## How you verified it

The tests need `AGENT_ORG_HOST` pointing at a checkout that holds `.agent-org/project.json` (this worktree has none, and the command refuses without it on `main` too); I ran with it set to `a11y-witness`'s `host.json`. The Acceptance line is the row's command without its `cd /home/agent/repos/agent-org`: that path holds `main`, which carries this change only after the merge.

```
$ node --import tsx --test src/triage-provider.test.ts src/triage-route.test.ts
ℹ tests 47   ℹ pass 47   ℹ fail 0
$ (the 15 test files that import triage-provider, triage-route or decision-provider)
ℹ tests 294   ℹ pass 294   ℹ fail 0
$ node_modules/.bin/tsc --noEmit -p tsconfig.json   # only the pre-existing mjs-ratchet.test.ts missing-module errors
```

The recorded shape is a test: `asks-this-seat=no` at 0.9 and the other four under 0.7 digests, with its negative control (the same five answers under a flat 0.7 wake, because `names-red-main` falls back to `yes`); `names-red-main=yes` at 0.3 wakes with `asks-this-seat=no` at 0.95 beside it, and so does a `no` under the guard's floor.

Acceptance: `node --import tsx --test src/triage-provider.test.ts src/triage-route.test.ts`

Mutation: 17 mutants, each killed by a named test, both directions (the asks-this-seat rule never or always firing before the red-main wake; the red-main and chairman wakes never firing; the guard floor at 0.7 and at 0; the repeat floor at 0.7; `said` holding the used value, a value for an unanswered question, or not returned or not written; `reason` never or always written; the incident at exactly 50 asks, at exactly 5%, never and always; unreadable lines not counted). Sources restored with `cp` and proved byte-identical.

## Anything a reviewer should be sceptical of

- **The floors are a guess until `said` has accumulated.** Median weakest confidence on the recorded asks was 0.22, so if the provider is that unsure of the two wake guards the digest share may stay low; the incident line and `said` are what say so.
- **Holding on one answer is the row's direction, and it holds more.** Only a confident `asks-this-seat=no` (host floor, 0.7) with no red main and no chairman direction does, and the hour's flush still delivers what was held.
- **A host's own `minConfidence` no longer governs `repeat` and the two guards**, which have their own floors; it still governs the answers that can hold an order alone.
- **The live reading is its own verify row**, not this one.
