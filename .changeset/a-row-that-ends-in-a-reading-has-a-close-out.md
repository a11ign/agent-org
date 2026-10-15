---
"agent-org": minor
---

A row that ends in a reading now has a close-out (a11ign/agent-org#1536). A worker whose claim names no pull request (`Claimed-nothing:`) closes its row with `worker:state done <row> --met=<item>:<comment>,...`, naming each Done-when item it reads as met and the comment that holds the reading. The row is closed first, with that list as its closing comment; the worker is released only once that close has landed, so a failed close leaves the row open and the worker not released. A `done <row>` with no `--met` is refused (`missing-met`), and so is a reading that leaves a Done-when item unmet (`unmet-done-when`) or names a comment not on the row (`unknown-comment`): nothing is written and nothing is closed. A `done` on a claim with an open or merged pull request reads exactly as before.

The gate's claim-stall tick now orders an `in-progress` row closed to `product-manager` when its claimant has been idle for 15 minutes after its own `VERIFIED` or "Done-when … met" comment (`verifiedCloseOrder`, `idle-claimant.ts`). The order names the row and the note, and asks `product-manager` to close the row only when each Done-when item is met. A row whose commit git cannot answer is held, not ordered.
