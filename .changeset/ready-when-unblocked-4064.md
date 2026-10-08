---
"agent-org": minor
---

A cleared row is promoted by the gate when its filer declared it so (a11ign/a11ign#4064, #4055 move 1a). A body line `Ready-when-unblocked: yes` means "complete except for its edges"; when the last `blockedBy` edge closes, the tick (no model, `src/work-gate/ready-when-unblocked.mjs`) re-reads the row and, only if it is still a plain `backlog` row (no `parked`, `needs:chairman`, `answer:*`, claim or not-startable label, no future `Not-before`), still declares the line, passes the claim rule's template check on the LIVE body and has no merged PR already naming it, promotes it through `row-file --promote` (which re-runs the filing rule) and logs `PROMOTED #<n> (blockers cleared, Ready-when-unblocked)`. A row without the line, or one that fails any check, keeps today's `unclaimed-blocker-cleared` order to `product-manager` unchanged; a refusal logs `NOT PROMOTED #<n>` with the reason.
