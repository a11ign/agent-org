---
"agent-org": patch
---

The work tick runs the messaging audit (a11ign/agent-org#620, follow-up to a11ign/a11ign#4746, #928). `recordTickFailures` in `failure-recorders.ts` now calls `auditMessaging` once per tick, after the other recorders, over the messaging ledger and a `messaging-audit-cursor` beside `failure-ledger`, so an announcement that asks the chairman something appends one `messaging-audience-misuse` line instead of being exported and never run. The count line `messaging audit: n checked, m flagged` goes to stderr with the other recorders' lines (stdout is the tick's orders). A host with no messaging ledger reads as an empty one and writes only the cursor.
