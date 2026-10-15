---
"@a11ign/agent-org": patch
---

A tick that exits `CANNOT_ASK` because it could not read its lanes now records one blind sample in the machinery canary before it exits, so `blind-ticks` counts it. Such a tick also no longer restarts the held-order and approved-unqueued clocks the canary keeps for its suppressions.
