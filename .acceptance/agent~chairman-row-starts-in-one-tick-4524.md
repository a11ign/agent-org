A `priority:chairman` row the CLAIM refuses after the precheck passed is told to the row, once per cause (a11ign/a11ign#4524, the third reopening); and a mixed batch with every engineer holding a row starts the chairman row first.

- `src/wake.ts`: `spawnWorker` hands the claim's refusal to a new `claimRefused` seam (`deliver` -> `targetFor` -> `spawnWorker`), and `sayClaimRefusal` writes it through the existing `sayOnChairmanRow` (marker `chairman-row-hold:<row>:claim:<hash of the refusal>`) for an order carrying `startFresh` only. The tick wires `sayClaimRefusal()` beside `spawnClaimability()`.
- `src/wake-start-fresh.test.ts`: four cases through `deliver`: a mixed batch (one chairman row, three plain rows, every engineer idle and holding a row) whose first STARTED is the chairman row; the claim's refusal (the 2026-10-10 journal text, B4 against #4738) written once across three ticks; a plain row's identical refusal writes nothing and a different cause is a second comment; a failed write is said and the refusal stands.
- `.changeset/a-chairman-row-the-claim-refuses-after-the-precheck-is-told.md`: the changeset every change here carries.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/wake-start-fresh.test.ts
```

Closes: a11ign/a11ign#4524

Reproduction (measured, `journalctl --user -u a11ign-work-tick`, 2026-10-10 09:16-09:26 BST = 08:16-08:26Z): `UNDELIVERED engineers/ready-row-unclaimed/4764: no engineer is idle and allowed to claim (...); no spawn: the claim of #4764 as worker-4764 did not hold (NOT CLAIMED: overlaps the Region of #4738, a row already claimed (`in-progress`) that has no open pull request declaring `Closes #4738` yet, and which declares: agent-org:src/engineer-route.ts, ...)`, six ticks; the refusal is the claim's, made inside the spawn, after `spawnClaimability` (open pull requests only) had passed. `startsFresh` had lifted the allowance and the pool, so neither named suspect (`MAX_SPAWNS_PER_TICK` taken by plain orders, holders counted toward the pool) was the cause.

Verified (measured, in `agent-org-wt-4524b` with `AGENT_ORG_HOST=/home/agent/repos/wt-4524/.agent-org/host.json`): the command above prints `VERDICT pass: 19 tests in 1 file`; `src/wake*` and `src/work-gate*` (51 files) print `VERDICT pass: 683 tests in 51 files`; `tsc --noEmit` has only the two `mjs-ratchet` errors `origin/main` already has.

Mutation: three single-line mutations of `src/wake.ts`, each restored byte-identical (`cp` before, `diff` after): the claim refusal never handed to `claimRefused` (the written-once, the control and the failed-write tests red, 3 of 19, nothing else); `sayClaimRefusal` ignoring `startFresh` (the plain-row control red, 1 of 19, nothing else); `deliver` walking its orders in reverse (the new mixed batch and the two older chairman-ordering tests red, 3 of 19).

Not in this PR, and why: the gate's `overlapVerdict` OFFERS a chairman row over a non-chairman holder (the chairman's 2026-10-09 amendment, "the holder rebases onto it"), while `row-claim`'s B4 and the precheck still refuse it, so the row is offered and refused every tick until the holder merges. Making the claim honour that is `src/row-claim.ts`, outside this Region, and `ceo` ruled 2026-10-09 that B4 is not overridden: it is reported on #4524 for a ruling, not decided here. The ordering change ("chairman first") is not made: the gate lists chairman rows first (`offerOrder`), `deliver` keeps that order, and no input exists where a passing chairman row loses the spawn to a plain row.

platform: checked whether GitHub already says why a claim refused: it does not, the refusal is `row-claim`'s own text, so the once-per-cause write reuses the marker comment `sayOnChairmanRow` already writes and keeps nothing in the ledger.
