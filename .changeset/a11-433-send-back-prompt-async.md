---
"agent-org": patch
---

The board no longer holds its loop on a synchronous herdr prompt when it sends a refused plan back to its planner (A11-433). That prompt now goes over the async herdr, so the board keeps working while herdr answers. `src/ticket-mode/pool-resume.ts` leaves `blocking-calls.baseline.json`.
