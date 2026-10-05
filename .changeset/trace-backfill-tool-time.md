---
"agent-org": patch
---

`trace` gives a turn stored before `toolMs` existed its tool time, by moving the ingest state to version 3 (`src/trace/ingest-state.mjs`). A state of another version is already a cold start, so the first run after this release reads every transcript from byte 0 once, and `appendToStore` supersedes each stored turn with the copy that carries `toolMs`; until then a worker's old tool time printed as `unexplained`. Measured 2026-10-05 into a SCRATCH store (never the live one), over the transcripts changed since 2026-09-28 with no wake ledger, gh ledger or deferral log: 1,733 transcripts, 1,339,543,558 bytes read, 21.1 s wall-clock, 702 MB peak RSS, 63,225 events. That is inside the tick; the supersede appends only the turns whose copy differs. The state is trusted again from the run after. a11ign/a11ign#3680.
