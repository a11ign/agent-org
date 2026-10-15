---
"agent-org": patch
---

A queued handoff order whose session the org does not know (no pane, not a standing seat, reviewer or lead seat) is dropped once it has been unknown for two hours (`UNKNOWN_SESSION_MS`, the same bound as `HANDOFF_STALE_MS`). Before this, such an order was redelivered every tick and never dropped: 593 lines in 26 hours for agent-org#1416. `dropUnknownHandoffs` runs on each tick after the ended-session settle. Each drop appends a `dropped` record carrying the prompt (so `prompt:session` re-sends it), prints one `DROPPED` line, and comments on the row the order names. A session that comes back clears its clock, and nothing is dropped while the account is paused.
