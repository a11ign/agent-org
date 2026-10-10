A merged pull request counts as a holder's landed work only if it merged AFTER that holder's `session:<name>` label was added (a11ign/a11ign#4789, option (a)). `claimFactsFrom` anchors a merge to the later of the newest claim record and the newest `labeled` event of the session's label, read through a new `HostReads.labelEvents` seam, so a hand-started engineer (a label and no record) is no longer released for the previous holder's pull request: a11ign#4524's `worker-4524` was released four minutes after its start for agent-org#562, merged ten hours earlier. A label time that cannot be read (a refused read, or a history with no such event) is `holding`, with the pull request and the reason in the message, never a release. A merge after the label, and a claim by `row-claim`, release as before, and a caller that gives no seam reads as before.

Closes a11ign/a11ign#4789

## What changes, and why

- **`claim-stall.ts`.** `landedWork` (the anchor), `sessionLabelAddedAt` (the newest `labeled` event of `session:<name>`, `null` for none, never zero), `readLabelEvents` (one `gh api` call, `null` for any read that did not answer in full), `HostReads.labelEvents`, `ClaimFacts.mergedHeld` and the `holding` reading `mergedReading` returns for it.
- **`work-gate/claim-stall-tick.ts`.** `LIVE_HOST_READS` carries the seam for the tick (the Region was re-scoped on the row: without it the fix is inert in production). The call is made only for a claim with a merged pull request of its own after the record, so a quiet org spends none.
- **Why option (a) and not (b).** The previous holder's records read `claimed by worker-4524`, the same session name as the new one (the row's own number), so the record's author cannot tell the two apart; the label's time can.

## How you verified it

`AGENT_ORG_HOST` must be set (unset, the files report `0 of 0 tests`, which is not a verdict); I set it to the a11y-witness checkout's `.agent-org/host.json`.

```
$ npx rstest run --config scripts/rstest/rstest.config.ts src/claim-stall-hand-start.test.ts
VERDICT pass: 9 tests in 1 file
$ npx tsc --noEmit -p tsconfig.json     # only the two pre-existing mjs-ratchet.test.ts errors
$ npx rstest run --config scripts/rstest/rstest.config.ts            # whole suite
VERDICT fail: 34 of 8196 tests failed in 449 files
```

The failing files are `board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock*`, `mjs-ratchet` and `pr-template-acceptance`, `public-claim`: the same 19 of 145 tests fail in those 8 files on a detached `origin/main` and here (measured, both runs), and none reads a claim.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/claim-stall-hand-start.test.ts`

Mutation: the label never anchors (`fromRecord` returned) -> 1 red (#4524's case); an unreadable label falls back to the record -> 1 red (the held twins); the seam asked for a row with no merge -> 1 red (the asked-once case); a hold whenever the seam is present -> 5 red; the tick's `LIVE_HOST_READS` without the seam -> 1 red. Each file was restored from a copy and diffed byte-identical.

## Anything a reviewer should be sceptical of

- **`claimedAt` is still the record's time.** A hand-started engineer's stall clock still starts at the previous holder's record, so it can be nudged early and released two hours after, which is the same family and is not this row's Change. Filed separately.
- **An unreadable label time holds the row's clock reading for that tick.** `holding` pre-empts the nudge and stall readings while a merged pull request of the holder's counts from the record and its label cannot be dated; it is logged each tick the read fails, and the next tick that answers resumes.
- **The seam is one REST call per such row per tick**, with no cache. It is asked only after a merge is found, and a release ends the claim, so a row asks again only while it is held.
