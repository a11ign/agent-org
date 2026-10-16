---
"agent-org": patch
---

A claim of a backlog row no longer leaves `backlog` on it beside `in-progress` (a11ign/agent-org#1568). `labelSetForClaim` now drops `backlog` with `ready` and keeps every other label. A release of a row claimed from backlog writes `backlog` back, so the row is not left with neither state.
