`verifiedCloseOrder` counts a comment as the claimant's VERIFIED note only when its `decided-by` marker is absent or names the claimant, and it refuses nothing: no `NOT closing`, no `not met` (a11ign#5311; agent-org#1596). The shared account alone no longer makes a note the claimant's.

**What changes.**
- `src/idle-claimant.ts`: `isVerifiedNoteOf(body, claimant)` is the per-comment reading; `verifiedCloseOrder` keeps the account filter (`claim.author`) and adds it. `REFUSAL_NOTE` matches anywhere in the body, so a refusal wins on a doubt.
- `src/work-gate-verified-close.test.ts`: three new cases, each through the claim-stall tick. A shared-account note marked `decided-by: product-manager` that says Done-when met and refuses nothing orders nothing; the claimant's own note that says NOT CLOSING and NOT met orders nothing; a POSITIVE CONTROL, the claimant's self-marked VERIFIED note 16 minutes old, orders the close.
- Assumption, said so: a note with no `decided-by` marker counts as the claimant's (the wrapper appends the marker only inside a herdr workspace), as it did before.

Mutation: each in the live file, restored byte-identical (copy in the scratchpad, `diff`): marker filter removed (1 red: the product-manager case); refusal check removed (1 red: the NOT CLOSING case); claimant-marked notes always rejected (1 red: the self-marked POSITIVE CONTROL).

Evidence: `node --test src/work-gate-verified-close.test.ts` 10 of 10 (7 before the change, the 2 refusal cases failing on the unchanged code). `src/worker-state.test.ts` with `src/work-gate-claim-stalled.test.ts` 179 of 179. `rstest` on the three files 189 tests, 0 failed. `npx tsc --noEmit -p tsconfig.json` exits 0. The Open-check snippet from the row now returns `null` for the product-manager note (it returned a close order before).

Acceptance:
```bash
node --test src/work-gate-verified-close.test.ts
```

Closes #1596.

platform: n/a (a predicate over the comments the gate already reads; no platform feature decides who wrote a comment)
