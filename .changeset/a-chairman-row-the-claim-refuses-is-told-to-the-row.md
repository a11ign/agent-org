---
"agent-org": patch
---

`wake` tells a `priority:chairman` row when the claim would refuse it (a11ign/a11ign#4524, the amended half). A chairman row refused at B4 (or by its `blockedBy` edge) produced a journal line only a reader of the whole journal found: four ticks of `UNDELIVERED ... #4629 would be refused at the claim by the file-overlap check (B4)` on 2026-10-09 were read as plain orders served first. `spawnClaimability` now writes the refusal, naming the overlapping pull request, once on the chairman row (a marker per row and cause; a failed write is said and retried). When that pull request is in the merge queue the line is a wait that names it (`#N waits for #P ..., which is in the merge queue`), the row is told once, and `splitRefusals` files it as DEFERRED for up to an hour (`MERGE_QUEUE_WAIT_LIMIT_MS`) instead of UNDELIVERED, so it no longer makes the tick exit ATTENTION. B4 is not bypassed. A plain row's refusal is unchanged and the merge queue is not read for it.
