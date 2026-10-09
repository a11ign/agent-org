---
"agent-org": patch
---

`wake` now honours `startFresh: true` on an order (a11ign/a11ign#4524, reopened). The gate has put it on a `priority:chairman` row's order since agent-org#518, and nothing in the spawner read it, so a chairman row waited on `UNDELIVERED ... no engineer is idle and allowed to claim` for five ticks. When no engineer is idle, such an order now starts a fresh engineer past the two PACE limits, `MAX_SPAWNS_PER_TICK` and the host-load refusal (`startsFresh`, only for a pilot order). The memory floor, the claim's own checks (B4) and the row-named address (`worker-<row>`, so at most one per row) still bind.
