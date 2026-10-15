---
"@a11ign/agent-org": patch
---

A pull request the merge queue ejected for a failure outside its own diff is re-armed by the gate once, when the newest merge group is green, behind the `queue.reenqueueEjected` flag (default off). `src/work-gate.ts`: `requeueEjected` (called from `readArmingOf`), `jobFailuresOf`, `ownershipOfFailure`, `failedEntriesSincePush`, `mergeGroupGreenSince`; a not-own ejection still unqueued after 15 minutes is counted into `approved-unqueued` and said once on the pull request. a11ign/a11ign#5125.
