---
"agent-org": patch
---

A daily approved-unqueued reading whose p90 read met a budget refusal is no longer filed as a finished day (a11ign/agent-org#1674). Its comment's p90 cell says `gate-budget: refused`, so the next tick with budget reads the p90 again and edits that day's comment in place, keeping its count. A day still refused when the next day's tick runs is stamped `count=unread` in its key, so its streak ends and no incident files on a day nobody could measure. `budgetRefusedIn` sits beside the day's key parsing in `src/approved-unqueued.ts`; a day with no refusal in its text is posted once and not read again, as before.
