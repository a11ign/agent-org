---
"agent-org": patch
---

`wake` tells a `priority:chairman` row when the CLAIM itself refuses it after the precheck passed (a11ign/a11ign#4524, the third reopening). Measured 2026-10-10 08:16-08:26Z: #4764 carried `priority:chairman` and five ticks said `UNDELIVERED ... no spawn: the claim of #4764 as worker-4764 did not hold (NOT CLAIMED: overlaps the Region of #4738, a row already claimed ...)`. Neither suspect was the cause: `startFresh` already lifts `MAX_SPAWNS_PER_TICK` and the pool, and the spawn was refused by B4's second half (a row already `in-progress`), which `spawnClaimability` cannot say because it reads open pull requests only. That refusal was a journal line and nothing else. `spawnWorker` now hands a claim refusal to `claimRefused` (`sayClaimRefusal`), which writes it once per cause on the chairman row; a plain row's refusal stays a journal line, and a failed write is said and retried. B4 is not bypassed.
