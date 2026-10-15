---
"@a11ign/agent-org": patch
---

NUL bytes in the claim-orders record are torn-write padding, so `claimOrdersIn` strips them before it parses a line: an entry written whole after a run of NULs is read and counted, and a line that is only padding is skipped without the "skipped an unreadable line" warning the work-tick repeated on every tick (agent-org#1065). A line that still does not parse once its padding is removed warns, as before.
