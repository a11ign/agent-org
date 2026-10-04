---
"agent-org": patch
---

A SENT `incident:` or `stall:` message now ends with `Impact:` and **`Being done:`** (it was `Doing:`): the newest comment an org account left on the open row whose body carries `Incident: <key>` (label `incident`), quoted with its age, or `nobody has picked this up yet` when no such row is open, or `I could not read it` when the read failed (the event is still sent). A CLEARED message gains `Lasted: at least <span> (counted from the message that told you)`, read from the ledger through the new `readEpisodeStart(key)` reader, and `not known` when it cannot be read. `readFixRow` changes shape (a row and its newest org comment, not a row and its holder) and now makes up to two `gh api` calls; `watch.mjs`'s read-only allowlist admits `issues/<n>/comments`. The hold-down, the key and `firstSeenAt` are unchanged (a11ign/a11ign#3419).
