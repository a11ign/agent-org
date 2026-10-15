---
"@a11ign/agent-org": patch
---

The daily retro prints two lines for the emergency-priority ledger kinds over its 24 hours: honoured uses (`emergency-priority-used`) and misuses (`emergency-priority-not-honoured`), each distinct ref counted once. A readable ledger with none prints `0`; an unreadable one prints `unknown`, never `0` (agent-org#990).
