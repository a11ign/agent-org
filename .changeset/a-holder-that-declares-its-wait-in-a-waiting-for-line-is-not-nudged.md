---
"@a11ign/agent-org": patch
---

A holder that declares its wait in a `Waiting-for:` line of the row's body is no longer nudged or ledgered as `claimed-worker-stalled` while the condition is unmet. The claim-stall reader read only the waits the row's fields carry, so `Waiting-for: merged #4437` in a body was ignored. The line is now read against the same facts the work gate reads for ready rows; a condition that is met, or unknown (a `manual` wait, an unread reference, an unreadable line), is not an excuse (a11ign/agent-org#1183).
