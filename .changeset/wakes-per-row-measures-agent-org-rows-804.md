---
"@a11ign/agent-org": patch
---

wakes:per-row measures an agent-org row (agent-org#804). The org records a `worker-<key>-<n>` instance's row as the bare number, which read as the project's own tracker's row, so no claimant was found and 83 of 176 rows read UNMEASURED; `keyInstanceRows` keys those numbers to the instance's own tracker. The summary line now reads `measured M of N, UNMEASURED K = P%`, and a reading over 10% UNMEASURED prints `PARTIAL` beside the mean.
