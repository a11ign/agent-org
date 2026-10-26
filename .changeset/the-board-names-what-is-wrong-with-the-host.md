---
"agent-org": minor
---

The Runs page now names what is wrong with the host itself, in a banner above the runs with when it began (`src/ticket-mode/host-alerts.ts`, `hostAlerts` on `GET /api/queue`): `/tmp` holding more than 1,000 entries (it held 19,960 when the agents host panicked on 2026-10-25), a soft lockup in this boot's kernel log (the host no longer reboots for one, `kernel.softlockup_panic = 0`, so the board is where it is raised), a board or terminal serve the instance could not put back or finds held by another entry, and hang settings that differ from the text `src/host-kernel.ts` holds. The slow reads are made once a minute from the instance's tick, a read that fails keeps its last answer, and an alert clears itself when its condition does: there is no Dismiss. A11-279.
