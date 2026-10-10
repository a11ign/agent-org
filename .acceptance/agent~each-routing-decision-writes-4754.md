The decision log no longer has a line that reads `outcome: None`, and a routing counts once. `decide`'s request line carries `outcome: "asked"` (row option (a)), the outcome line `recordOutcome` writes is unchanged, and `decisionsIn(lines)` reads one decision per routing over the old shape, the new shape and a log holding both. Option (b), one line written when the outcome is known, was not taken: `class-match.ts` records a human's keep or removal days later in another process and `duplicate-row.ts` on a later filing, so a decision never given an outcome would leave no line at all.

Closes a11ign/a11ign#4754

## What changes, and why

- **The writer (`src/decision-provider.ts`, `logged`).** The request line gains `outcome: "asked"`, exported as `OUTCOME_ASKED`. Nothing else on it moves, so `answers`, `questions`, `fields`, `via`, `fellBack`, `reason` and `at` read as they did and `readAnswer` is untouched.
- **The reading (`decisionsIn`).** A line with `answers` is a request and opens a decision; the next outcome line of the same `use` and `id` closes it; an outcome line with nothing open is a routing nobody asked the provider about (an override, a use switched off) and is its own decision; a request never closed reads `asked`. Lines that are not a use and a time are skipped. It is keyed on `use`, `id` and file order (the log is only appended), and the entry's `at` is the request's.
- **The header.** `decision-provider.ts` names the two line shapes and why they stay two.
- **Outside the Region: `src/engineer-route.test.ts`.** Its log helpers took `outcome !== undefined` to mean "the outcome line"; that is the reading this row removes, so they now also require `answers === undefined`. One helper, four call sites, no assertion changed.

## How you verified it

`AGENT_ORG_HOST` must be set (the files import modules that resolve the host checkout at import; unset, they report `0 of 0 tests`, which is not a verdict). I ran with it set to this repository's `.agent-org/host.json`.

```
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.* src/decision-provider.test.ts
VERDICT pass: 20 tests in 1 file          # was 17 before the three new ones
$ ... src/decision-provider.test.ts src/engineer-route.test.ts src/class-match.test.ts src/duplicate-row.test.ts src/engineer-escalation.test.ts
VERDICT pass: 125 tests in 5 files        # every caller of the log; 122 before, +3 new
$ npx tsc --noEmit -p .                   # only the two pre-existing mjs-ratchet.test.ts missing-module errors
```

The affected set (`--changed=origin/main`, 243 files) shows 31 failures in 7 files (`board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock*`, `row-file*`). Those 7 files run on their own fail **25 of 310 in this tree and 25 of 310 on a detached `origin/main` (`dbd8be8`)**: the same count, none a decision-log consumer. The 6 extra in the wide run appear only under its load. Not rerun: the full suite and CI's tree-wide guards.

**Measured on the live log** (`~/.cache/a11ign/decisions`, read at 2026-10-10, the log having grown from the row's 161 lines): 185 `model-routing` lines, 87 with no `outcome`; `decisionsIn` reads 98 decisions, 87 of them asked, none left open. One per routing, where the lines were 185.

**The sibling confidence reading** (#4748, unmerged when I looked): its outcome test reads `answers === undefined` with a string `outcome`, so a request line, which keeps `answers`, is still a decision there. Read, not run: its file was not on `origin/main`.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/decision-provider.test.ts`

Mutation: writer never writes `outcome: "asked"` -> 2 red (the pinned request line, and the new "no line reads None" test); reader never pairs -> 3 red (the new routing test, the control and the mixed log); reader pairs on `use` alone -> 1 red (the mixed log, only once two ids were open at once: the first fixture let this one survive, which is why that case is there); reader drops outcome-only routings -> 1 red; all restored byte-identical (diffed).

## Anything a reviewer should be sceptical of

- **Two lines, still.** The row's Done-when 2 says "ONE decision (the two lines pasted)", which this satisfies as one DECISION read from two lines. A reader that counts lines, or groups them by `outcome`, still sees two per routing; `decisionsIn` is the reading that does not, and no production reader of the log was changed to use it (none lives in this tool; the sibling reading is a different file).
- **`outcome: "asked"` is a value a caller could pass to `recordOutcome`.** `decisionsIn` tells a request from an outcome by `answers`, not by the label, so a caller's label of `asked` is still an outcome line; no caller uses it.
- **The control is built, not recorded.** "The writer as it was" is the new writer's request line with `outcome` removed, which is the only field that changed; the live log's own first lines are the same shape.
