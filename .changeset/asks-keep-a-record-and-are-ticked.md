---
"agent-org": minor
---

An ask keeps a record and its message follows the row. Each ask is `{askId, messageRef, row, state, outcome}`, written when it is first sent; one with no row is refused at send, naming why, unless its kind declares it has none (a stall). When the row closes, loses `needs:chairman` or is answered, the original message is EDITED to `✅ <outcome> — <first line>` and nothing is sent, and one pinned message lists the open asks (row, first line, age), rewritten only when the set changes and pinned once. Reminder messages stop for a kept ask: the list is its reminder. A provider that cannot both edit and pin keeps the old lifecycle. a11ign/a11ign#4745.
