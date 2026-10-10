An idle or done `worker-<n>` pane on a closed row loses the row's claim labels ten minutes after the close, in either tracker, so the spare teardown ends it. Closes a11ign/agent-org#745 (a11ign#4437, chairman 2026-10-10).

Closes a11ign/agent-org#745

## What changes, and why

- `holdsClosedRow` (`src/work-gate.ts`) held every listed `worker-<n>` for ever. A `worker-<n>` now holds a closed row while herdr reports it anywhere but idle or done, and for 10 minutes after the close when it is idle or done. A missing, unparseable or future `closedAt` still holds; a standing seat's one-day grace is unchanged. `closedClaimDebris` hands each pane's status to it.
- `readClosedClaimLabelRows` asks every declared tracker (the home one unaimed as before, the others aimed), tags another tracker's rows with `repo`, and the strip acts in that repository. A refused tracker is named in `unread` and said on stderr; the others' rows are still decided, and `rows` is `null` only when every read was refused (never `[]`).
- The existing #3900 case "a listed worker's row closed 3 days ago is KEPT" read a worker with status `idle`; it now uses a `working` pane, since an idle one is exactly what this row releases. The #3883 (6) and (7) cases ask the home tracker only / once per declared tracker.
- Changeset (patch).

## How you verified it

Run with `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json`, from the worktree (the row's `cd` path holds `main`, which carries this only after the merge).

```
$ node --import tsx --test src/packaging/closed-row-ends-instance.test.ts
ℹ tests 42   ℹ pass 42   ℹ fail 0
$ node --import tsx --test src/work-gate-claim-stalled.test.ts src/packaging/row-call-count-waiting-rows.test.ts src/packaging/work-gate-awaiting-evidence.test.ts src/work-tick-cost.test.ts src/packaging/wake-drain.test.ts src/packaging/closed-row-ends-instance.test.ts src/packaging/board-prose-skips-closed-rows.test.ts
ℹ tests 257   ℹ pass 257   ℹ fail 0
$ node_modules/.bin/tsc --noEmit -p tsconfig.json   # two errors, both in src/packaging/mjs-ratchet.test.ts (`@a11ign/toolchain/mjs-ratchet` not installed in this worktree's linked node_modules); none in a touched file
```

Positive control (#745 (1): 11 minutes, idle and done, stripped), negative controls (#745 (2): 2 minutes idle/done, 11 minutes working/blocked, 300 minutes working: kept), the boundary and the fail-toward-holding `closedAt`s (#745 (3)), a status that is neither idle nor done (#745 (4)), a second tracker's row read and stripped with `--repo a11ign/agent-org` (#745 (6)), a refused read null and one tracker's refusal named without taking the other's rows (#745 (7)), and one read per declared tracker (#745 (8)).

Acceptance: `node --import tsx --test src/packaging/closed-row-ends-instance.test.ts`

Mutation: 5 mutants, each killed by its own tests and restored with `cp`, `diff` clean. The worker always held (`#745 (1), (3), (5), (6)` red); an idle worker always stripped (`#745 (2), (3), (6)` red); the home tracker only (`#745 (6), (7), (8)` and `#3883 (7)` red); an all-refused read returned as `[]` rather than `null` (`#745 (7)` and `#3883 (6)` red); the strip ignoring the row's repository (`#745 (6)` red).

## Anything a reviewer should be sceptical of

- `worker-agent-org-<n>` (a keyed pane) is not a `worker-<n>`: `familyNumber` returns `null` for it, so it keeps the standing seat's one-day grace here. That is agent-org#757's half, which edits the same functions and is not redone here.
- The live reading (an idle pane on a closed row is gone within the next ticks) is its own row, filed when this one closes (agent-org#719); this PR does not claim it.
- One more `gh issue list` per tick (one per extra declared tracker, one in `a11ign`'s case), asked inside the follow-ups' existing batch and only when herdr's listing is complete. Counted by reading `GH_READS`, not measured on a live tick.
