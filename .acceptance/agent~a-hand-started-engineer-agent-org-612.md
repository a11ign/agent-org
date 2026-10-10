A claim's stall clock starts at the later of the newest claim record and the newest `labeled` event of the holder's `session:<name>` label (a11ign/agent-org#612). `claimFactsFrom` takes the tick's `now` and, for a record older than the stall interval, reads the label's time through the existing `HostReads.labelEvents` seam, so a hand-started engineer (a label and no record) reads `moving` at its first tick instead of being nudged for the previous holder's idle window.

Closes a11ign/agent-org#612

## What changes, and why

- **`claim-stall.ts`.** `claimClock` (the later of record and label; the seam is asked only for a record at least the stall interval old, and with no `now` or no seam the record stands), `ClaimInput.now`/`intervalMs`, `ClaimFacts.clockHeld` (why an unreadable label time kept the record's), and one memoised label read shared with `landedWork`, so a claim with a merge to judge still asks once.
- **`work-gate/claim-stall-tick.ts`.** The tick passes its `now` and logs `clock kept at the claim record: <why>` for a label time it could not read. The reading itself is today's, so a refused read never nudges sooner.

## How you verified it

`AGENT_ORG_HOST` must be set (unset, the files report `0 of 0 tests`, which is not a verdict); I set it to the a11y-witness checkout's `.agent-org/host.json`.

```
$ npx rstest run --config scripts/rstest/rstest.config.ts src/claim-stall-hand-start-clock.test.ts
VERDICT pass: 7 tests in 1 file
$ npx rstest run --config scripts/rstest/rstest.config.ts src/claim-stall src/work-gate-claim-stalled.test.ts src/work-gate
VERDICT pass: 515 tests in 40 files
$ npx tsc --noEmit -p tsconfig.json     # only the two pre-existing mjs-ratchet.test.ts errors
```

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/claim-stall-hand-start-clock.test.ts`

Mutation: the label never anchors -> 3 red; the label replaces the record (an earlier label pulls the clock back) -> 1 red; an unreadable label starts the clock at `now` -> 2 red; the seam asked for every claim -> 1 red; the tick gives no `now` -> 1 red. Each file was restored from a copy and diffed byte-identical.

## Anything a reviewer should be sceptical of

- **"Saying why on the HELD line" is a log line, not a `holding` reading.** An unreadable label time keeps the record's time, so the reading is today's (a nudge where today nudges); making it `holding` would suppress a nudge a record-only reading gives, which the row's "reads as the record's" test forbids. The reason is logged once per tick the read fails, and only for a record already past the interval.
- **A quiet row with a record older than the interval now spends one REST call per tick** (`issues/<n>/events`), where #4789's seam was asked only after a merge was found. That is the row's own Change (2), and the call is shared with the merged anchor.
- **The role file `.agent-org/roles/engineer.md` is not in this repository's tree**; I read the newest copy in a sibling checkout (`wt-4823`).
