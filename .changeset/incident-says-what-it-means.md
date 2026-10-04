---
"agent-org": patch
---

A SENT `incident:` or `stall:` event now carries two more lines after what started: **Impact** (a fixed table keyed by the event's own key: `Nothing can merge.`, `No worker can be woken.`, `Captures are paused.` and so on, `not known` for a key with no entry) and **Doing** (read once through the optional `readFixRow(key)` reader: the open row and its holder, `no row is open for this yet` only when the reader says `null`, and `not known` when the reader is not wired, throws or returns a non-row). The "cleared" text, the event's key, `firstSeenAt` and the core's hold-down and dedupe are unchanged, and a failed fix-row read never withholds the event. `readFixRow` is not wired in `readers.mjs` yet, so Doing reads `not known` until it is (a11ign/a11ign#3424).
