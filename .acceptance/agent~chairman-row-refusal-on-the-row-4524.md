A `priority:chairman` row the claim would refuse is told to the row, and an overlap with a pull request in the merge queue is a wait (a11ign/a11ign#4524, the amended half).

- `src/wake.ts`: `spawnClaimability` returns the same reasons as before and, for an order carrying `startFresh`, writes the hold once on the row through a leak-guarded `post` (marker `chairman-row-hold:<row>:<cause>`, read back from the row's comments). `firstOverlap` asks B4 one pull request at a time so the PR is known; `inMergeQueue` reads GraphQL `mergeQueueEntry` for that one PR, for a chairman row only. `splitRefusals` files a `waits for <PR>, which is in the merge queue` line as DEFERRED under `MERGE_QUEUE_WAIT_LIMIT_MS` (one hour).
- `src/wake-start-fresh.test.ts`: six cases through `deliver` and the real `spawnClaimability` with a fixture GitHub: a mixed batch (a refused chairman row beside plain rows that pass and one that is refused), written once across ticks, a queued PR as a wait that is then started after the merge, the control (not queued is UNDELIVERED), a plain row is never written to and the queue is not read for it, and a failed write is said.
- `.changeset/a-chairman-row-the-claim-refuses-is-told-to-the-row.md`: the changeset every change here carries.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/wake-start-fresh.test.ts
```

Closes: a11ign/a11ign#4524

Verified (measured, in `agent-org-wt-4524` with `AGENT_ORG_HOST=/home/agent/repos/wt-4524/.agent-org/host.json`): the command above prints `VERDICT pass: 15 tests in 1 file`. Against `origin/main`'s `wake.ts` the same file fails 4 of 15 (the mixed batch, written once, the queue wait, the failed write). All 229 tests of `src/wake*` pass; with `src/packaging/wake*`, `deferred*`, `stuck*`, `engineer-route`, `spawn-memory-floor`, `deferral-log`, `haiku-tier`, `work-gate`, `repeating-lines`, `prompt-session` (983 tests, 33 files) one test fails, `src/packaging/wake-engineer-brief.test.ts` "packages/lab/CLAUDE.md: the addition names the paths it governs", which fails identically with `origin/main`'s `wake.ts` (it reads a11ign's `packages/lab/CLAUDE.md`, not this diff). `tsc --noEmit`: only the `mjs-ratchet` errors `origin/main` already has.

Mutation: five single-line mutations of `src/wake.ts`, each restored byte-identical (`cp` before, `diff` after): the row write never fires (the mixed batch, written-once, queue-wait and failed-write tests red, nothing else); every order treated as chairman (the mixed batch, which pins that only the chairman row is written to, and the plain-row test red); the queue never read as queued (the queue-wait test red); always read as queued (the mixed batch, the not-queued control and the failed-write test red); the marker ignored (written-once and the queue-wait test red).

Not in this PR, and why: the case "a passing chairman row is the first STARTED" is DROPPED, as the amended Acceptance allows. A pass with three plain rows ahead of a chairman row (the existing allowance test, `deliver([100, chairman, 101])`) starts the chairman row because `startsFresh` lifts the per-tick allowance, so no case exists where a passing chairman row loses the spawn to a plain row; no ordering change is made. Other chairman-row refusals (the memory floor, an address already holding a process, every seat full) are still journal lines only: their text carries numbers that change tick to tick, so a once-per-cause marker needs a stable key first. A plain row waiting on a queued PR is still UNDELIVERED; extending the wait to it is one `chairman &&` away and costs one GraphQL read per distinct PR per tick, which this row did not claim.

platform: checked whether GitHub already says a pull request is queued: `gh pr view --json` has no merge-queue field, so it is the GraphQL `mergeQueueEntry` on one pull request; the once-per-cause write is a marker comment read back from the row, the pattern `askOnce` already uses, and nothing is kept in the ledger.
