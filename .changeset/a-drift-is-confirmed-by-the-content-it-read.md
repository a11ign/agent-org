---
"@a11ign/agent-org": patch
---

A webhook reconcile no longer files a missed delivery when only a repository's ETag moved. The tag can change between two reads of the same issues list (the same five items, different tags), so drift now needs the newest `updated_at` or the item count to have moved too; a tag that moved over the same content is counted for the day in `read-cache/event-drift-suppressed.json` and not filed. The drifts of one reconcile pass are filed as one incident naming every drifted repository, not one per repository (a11ign/agent-org#1207).
