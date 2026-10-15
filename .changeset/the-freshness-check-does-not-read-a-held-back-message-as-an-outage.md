---
"@a11ign/agent-org": patch
---

The trace-freshness check no longer reads a store as stale when a session speaks again after a quiet. The ingest holds back every message written in the last five minutes, so a session that went quiet and then spoke had messages newer than the store's newest turn that no turn could yet exist for, and the check raised a `metrics-outage` incident on a healthy store (a11ign/agent-org#836, the third false positive of #498). A session now counts as working only when it wrote a message inside the window AND that message is past the hold-back, the one the ingest is owed a turn for (`newestMessageAt` takes the newest message at or before `now - QUIET_MS`). `freshnessLine` says so. A store is still stale when it is more than ten minutes old while such a message exists, and `STALE_AFTER_MS` is unchanged.
