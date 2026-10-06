---
"agent-org": patch
---

The gate asks for its tracker lanes together instead of one after the other. `main` read the backlog, `needs:chairman` and open lists, then the claimed rows' comments, the closed-answer label list and the recently closed rows, each through the synchronous `gh`; they now go out as two batches (`readTrackerLanes` after the outage check, `readOpenRowFollowUps` once the open rows are in hand) through `readWithFirstWaveTogether`, the seam slices 2 and 3 use. The commands, their parsing and the orders are unchanged, no read is added (the conditional ones stay conditional on the rows in hand, and the lists are still asked after the check that both pull-request and Ready reads were refused), and a refused read is that lane's `null` and nobody else's. What a batch cannot foresee (a chairman row's events, the closed-answer searches built from the label list) still runs one at a time. a11ign/a11ign#3566, slice 5 of the tick's cost.
