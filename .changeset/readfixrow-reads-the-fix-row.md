---
"agent-org": patch
---

`createReaders` gains `readFixRow(key)`, so the `Doing` line of a SENT incident or stall can name the open row that holds the fix instead of reading `not known`. A fix row says which incident it fixes by a label named for the event key (`incident:trunk-red`, `stall:no-merge`), and the holder is its `session:<name>` label. The reader returns `null` only when GitHub answered and no open row carries the label, and throws when it could not be asked (a11ign/a11ign#3439, follows #3424).
