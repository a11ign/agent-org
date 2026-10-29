---
"agent-org": patch
---

Doctor's `merge flow` row reads GitHub, and the remotes of the host's clones, without holding the instance's loop still (A11-395, step 1 of 2). The GitHub plugin gains an async form of each operation the board makes on an event (`readQueueFailureAsync`, `holdPullRequestAsync`, `releasePullRequestAsync`, `readDefaultBranchRedAsync`, `readOrganisationFlowsAsync`, `readRepositoryFlowsAsync`, `readClosedWorkAsync`, `pullsNamingAsync`, `stackMergeFactsOfAsync`, `requestStackMergeAsync`, `readCiRunAsync`, `readCheckLogAsync`, `rerunFailedChecksAsync`, `rerunRunsAsync`, `updateBranchAsync`, `closePullAsync` and `commentOnPullAsync`), each making the same `gh` calls in the same order as its synchronous form. The code host does not hand them out yet, so the board is unchanged; the contract major that does is step 2.
