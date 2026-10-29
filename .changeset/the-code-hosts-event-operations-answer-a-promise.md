---
"agent-org": minor
---

The code host's event operations answer a promise, and the board awaits each one where it called it (A11-395, step 2 of 2; code host contract 4.0). `readQueueFailure`, `holdFromQueue`, `readDefaultBranchRed`, `readMergeFlow`, `readClosedWork`, `pullsNaming`, `sweepRetargets`, `stackMergeFactsOf`, `requestStackMerge`, `readCiRun`, `readCheckLog`, `rerunFailedChecks`, `rerunRuns`, `updateBranch`, `closePull` and `commentOnPull` ran `gh` on the board's thread and held its loop for as long as it took; the GitHub plugin now runs them through `deps.execAsync`. An operation that threw rejects with the same first line, `sweepRetargetsAsync` (2.2) is folded into `sweepRetargets`, and `armMerge` stays synchronous because nothing on the board's loop calls it. A code host plugin of major 3 is refused (`READ_MAJORS`), and the pool's `respond` answers a promise that the server awaits, so a refusal still reaches the request.
