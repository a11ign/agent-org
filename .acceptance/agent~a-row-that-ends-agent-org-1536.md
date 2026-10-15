A row that ends in a reading has a close-out. `worker:state done <row> --met=<item>:<comment>,...` closes a no-pull-request row (its claim names none, `Claimed-nothing:`) once the declaration reads every Done-when item as met, and releases the worker. The row is closed FIRST, with a closing comment that names each item read as met and the comment holding its reading (`closingComment`); the declaration is written only after that close has landed. A failed close writes nothing, so the worker is not released and the row stays open (`NOT CLOSED`, exit 2). `done <row>` with no `--met` is refused `missing-met`; a reading that leaves an item unmet is refused `unmet-done-when` naming the item; a comment not on the row is refused `unknown-comment`. A `done` on a claim whose pull request is open or merged reads exactly as before.

The gate's claim-stall tick orders an `in-progress` row closed to `product-manager` when its claimant's own `VERIFIED` or "Done-when … met" comment is at least 15 minutes old and the claimant is idle (`verifiedCloseOrder`, `idle-claimant.ts`, called from `verifiedCloseOf` in `src/work-gate/claim-stall-tick.ts`). At 14 minutes it does not. A commit git cannot answer holds the row: it is not ordered closed. Attribution is by the claim's author account and the claim's time, so it is a best reading and not a proof: a shared account would attribute another session's note to the claim.

Acceptance:

```bash
node --test src/worker-state.test.ts
node --test src/work-gate-verified-close.test.ts
```

Closes a11ign/agent-org#1536

Positive controls, each failing on `main` (`git show origin/main:src/worker-state.ts`):
- (a) `done` on a `Claimed-nothing:` claim with every Done-when item met → `excused`, "the reading is recorded and the row is closed". On `main` it is `lapsed`: "the row is still open and no pull request of it has merged".
- (b) the same with one item unmet → `lapsed`, naming the item. On `main` it is `lapsed` without naming it.
- (c) `done` on a claim with an open pull request reads exactly as it does on `main`.
- (d) an `in-progress` row, an idle claimant, and a VERIFIED comment from the claimant 16 minutes old → the gate's own tick (`claimStallTick`, `src/work-gate-verified-close.test.ts`) orders a `verified-close` to `product-manager`, naming the row and the note. At 14 minutes it does not. On `main` `verifiedCloseOrder` does not exist and no tick calls it.

Mutation, each file backed up with `cp` in the scratchpad, changed, run, and restored from the copy (checked with `cmp`):
- M1 the pull-request lapse removed from the done reading: 1 red.
- M2 unmet items never named in the refusal: 1 red.
- M3 `VERIFIED_CLOSE_MINUTES = 0`: 1 red.
- M4 `VERIFIED_NOTE` never matches: 2 red.
- M5 the closing-comment URL wording changed: 1 red.
- M6 the tick's `home.closes` dropped from its orders: 2 red in `work-gate-verified-close.test.ts` (control (d) and the 15-minute bound).
- M7 `VERIFIED_CLOSE_MINUTES = 16`: 1 red in `work-gate-verified-close.test.ts` (the inclusive 15-minute bound).
- M8 the idle check dropped from `verifiedCloseOrder`: 1 red in `worker-state.test.ts` (the not-idle twin). The gate's own twin does not reach it, because the tick checks idleness before it calls the helper.
- M9 the author filter dropped from `verifiedCloseOrder`: 1 red in `work-gate-verified-close.test.ts` (another account's note).
- M10 the unreadable-commit guard re-throws: 1 red in `work-gate-verified-close.test.ts` (the unreadable-commit twin, which also checks the tick's "could not run" line).

Out of this row's Region, disclosed:
- `src/close-rows-sweep.test.ts`: the sweep's exemption now keys `ticket-port/close-row.ts`, the port file that holds the close.
- `src/ticket-port/close-row.ts` (new): the write, so `gh-call-ratchet.test.ts` does not see a new spawn in `worker-state.ts`.
- `src/work-gate/claim-stall-tick.ts`: calls `verifiedCloseOrder` from the live tick (`verifiedCloseOf`, `verifiedCloseOrderOf`), so control (d) is a gate reading and not a helper's, and holds a row whose commit is unreadable.
- `src/decided-by.ts`: `DEFAULT_ANSWERER` moved here, a leaf that imports nothing, so `idle-claimant.ts` can name the reader without importing `worker-state.ts`. `worker-state.ts` re-exports it.
- `src/work-gate-verified-close.test.ts` (new): drives the gate's tick for control (d) and its twins.

Not covered by a test: the close-first order in `worker-state.ts`'s `main` (the close runs before `writeDeclaration`). It is checked by reading the code, not by a run: `main` shells out to `gh`, and no run here touched the tracker.

`docs/gh-call-baseline.json` is not changed.
