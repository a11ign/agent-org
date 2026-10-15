---
"@a11ign/agent-org": patch
---

The trace freshness check reads the clock once, before the ingest, and judges "past the hold-back" against that reading. A session that spoke once after a quiet spell no longer reads STALE because the ingest took seconds: its message was held back by the ingest at 4:58 old and was counted as owed a turn at 5:18.
