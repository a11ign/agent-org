---
"agent-org": minor
---

A standing lead whose previous order was recent AND whose window is over the fill line is now CLEARED, not compacted, when `state/<label>.md` exists beside the ledger's record directory and is within 8 KiB (`STATE_FILE_MAX_BYTES`, an unmeasured starting constant); with no state file it is compacted exactly as before. An empty, unreadable or oversized file is never used: an oversized one is refused with its size and left on disk untruncated, and the refusal rides on the delivery's `note`. A recent order under the line is still kept and an old one still cleared. Nothing writes a state file yet and nothing rehydrates from one, so this changes no delivery until a manager writes `state/<label>.md` at the end of a wake and a SessionStart hook reads it back (#4055 moves 5 and 6).
