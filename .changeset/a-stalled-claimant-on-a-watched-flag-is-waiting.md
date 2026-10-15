---
"agent-org": patch
---

The stalled-claimant check no longer nudges an idle claimant whose claimed row names a machinery flag the canary is still watching. `canaryWatching` (`src/work-gate/claim-stall-tick.ts`) reads the canary file for flags that are switched on, have no final verdict (`passed` or `reverted`), and are inside their hour; such a holder reads as `canary-hour` (waiting), not stopped. A row's own declared wait keeps its kind, and a canary file that cannot be read still nudges a quiet holder.
