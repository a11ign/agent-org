A row that ends in a reading has a close-out. `worker:state done <row> --met=<item>:<comment>,...` closes a no-pull-request row (its claim names none, `Claimed-nothing:`) once the declaration reads every Done-when item as met, and releases the worker. The row is closed with a closing comment that names each item read as met and the comment holding its reading (`closingComment`). `done <row>` with no `--met` is refused `missing-met`; a reading that leaves an item unmet is refused `unmet-done-when` naming the item; a comment not on the row is refused `unknown-comment`. A `done` on a claim whose pull request is open or merged reads exactly as before.

The gate's idle-claimant check (`verifiedCloseOrder`, `idle-claimant.ts`) orders an `in-progress` row closed to `product-manager` when its claimant's own `VERIFIED` or "Done-when … met" comment is at least 15 minutes old and the claimant is idle. At 14 minutes it does not. Attribution is by the claim's author account and the claim's time, so it is a best reading and not a proof: a shared account would attribute another session's note to the claim.

Acceptance:

```bash
node --test src/worker-state.test.ts
```

Closes a11ign/agent-org#1536

Positive controls, each failing on `main` (`git show origin/main:src/worker-state.ts`):
- (a) `done` on a `Claimed-nothing:` claim with every Done-when item met → `excused`, "the reading is recorded and the row is closed". On `main` it is `lapsed`: "the row is still open and no pull request of it has merged".
- (b) the same with one item unmet → `lapsed`, naming the item. On `main` it is `lapsed` without naming it.
- (c) `done` on a claim with an open pull request reads exactly as it does on `main`.
- (d) an `in-progress` row, an idle claimant, and a VERIFIED comment from the claimant 16 minutes old → the gate's reading names the row and orders the close. At 14 minutes it does not. On `main` `verifiedCloseOrder` does not exist.

Mutation, each file backed up with `cp` in the scratchpad, changed, run, and restored from the copy (checked with `cmp`):
- M1 the pull-request lapse removed from the done reading: 1 red.
- M2 unmet items never named in the refusal: 1 red.
- M3 `VERIFIED_CLOSE_MINUTES = 0`: 1 red.
- M4 `VERIFIED_NOTE` never matches: 2 red.
- M5 the closing-comment URL wording changed: 1 red.

Out of this row's Region, disclosed: `src/close-rows-sweep.test.ts` (the sweep's exemption now keys `ticket-port/close-row.ts`, the port file that holds the close), and the new `src/ticket-port/close-row.ts` (the write, so `gh-call-ratchet.test.ts` does not see a new spawn in `worker-state.ts`). `docs/gh-call-baseline.json` is not changed.
