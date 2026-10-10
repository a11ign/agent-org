---
"agent-org": patch
---

The trace-freshness check no longer reads a store as stale right after a cold start (a11ign/agent-org#709). A `STATE_VERSION` move or a lost state file re-reads every transcript and appends them in directory order, so the end of the store holds the OLDEST turns while its newest turn is minutes old; `newestTurnAt` took the newest turn of the last 1 MB, two days old, and raised a `metrics-outage` incident on a healthy store. It now reads on, a chunk further back at a time, while the newest turn it has found is older than the stale window, until a turn inside the window turns up or the file is exhausted; the 32 MB figure is the largest chunk and no longer a stop. A genuinely stale store still reads stale and a store with no turn still reads `null`. `STALE_AFTER_MS`, the episode rules and the order text are unchanged.
