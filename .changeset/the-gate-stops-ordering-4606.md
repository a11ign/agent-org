---
"agent-org": patch
---

The gate no longer orders a worker to fix a red pull request whose row waits on an open native `blockedBy` edge, until the head changes or the edge closes. A wait carried as DATA excused nothing (only a `hold:*` label did), so lab#49 at `a5b63eaf` was ordered 6 times against a cap of 3 and `STUCK ... delivered 6 times` repeated for 63 minutes. `withWaitingEdges` (`work-gate/pr-waits.ts`) stamps `waitingOn: { edges, head }` from the rows already in hand, `head` being the head the wait was first seen at (kept in `pr-waits.json`, forgotten the tick the edge is gone), and `failingChecksOrder` asks `isWaitingRed` beside `isHeldRed`. A push is a new head and the order is emitted again; a closed edge ends the wait; `endedRuns` writes `RESET` for the key that stopped. a11ign/a11ign#4606.
