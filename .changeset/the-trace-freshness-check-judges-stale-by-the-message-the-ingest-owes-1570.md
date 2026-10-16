---
"agent-org": patch
---

The trace-freshness check no longer calls a store stale because it has no turn from the last ten minutes. A store is stale only when a message the ingest owes a turn for has none: a message past the five-minute hold-back at the previous ingest, that is still turnless after this one (a11ign/agent-org#1570, the metrics-outage repeat of 2026-10-16). A session inside one long tool call wrote a message and then nothing, so the store was quiet for 12 minutes while its last settled message was not owed yet. Each transcript is compared on its own newest owed message (`owedTurns`), and the store is checked for a turn at or after it (`unmetOwed`). `working` is kept for display only, and `STALE_AFTER_MS` is unchanged.
