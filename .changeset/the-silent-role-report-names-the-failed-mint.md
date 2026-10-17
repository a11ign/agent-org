---
"agent-org": patch
---

The app-role-silent line on the host's stderr now names why the last token mint failed. A declared GitHub App role that made no calls was reported only as silent; when the ledger holds an `app-token <role>` failure for it, the line now ends with that failure's reason, its exit status and its time (`the mint failed at <time>: <reason> (exit <n>)`), or `no app-token incident in the ledger` when there is none. Nothing else changes: the failure's dedupe key and the failure event are the same as before (agent-org#1682).
