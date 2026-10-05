---
"agent-org": minor
---

The gate keeps each deferral that ENDED in a durable log, `wake-deferral-log` beside `wake-deferred`, one line `<causeKey>\t<startMs>\t<endMs>\t<delivered|gone>` appended by the tick that found the order no longer deferred, and the trace store reads it as `kind: deferral` (`source: deferral-log`), keyed to the cause key's row or pull request and ingested incrementally through the ingest state: `trace` prints each wait's span and its footer names the waits before the log's first tick as unrecorded (a11ign/a11ign#3510, slice 3 of #3494)
