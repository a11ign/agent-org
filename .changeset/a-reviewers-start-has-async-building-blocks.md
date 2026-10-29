---
"agent-org": patch
---

The steps of a reviewer's start and end that spawn a program have async forms (`src/wake/reviewer-start-async.ts`, `herdrRunAsync` and `readAgentsAsync` in `src/herdr-agents.ts`), so the board's loop can go on while a reviewer starts (A11-379, step 1 of 2). Nothing calls them yet: the reviewer port still starts a reviewer as it did, and row mode's synchronous forms answer as before.
