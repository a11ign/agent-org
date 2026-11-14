---
"agent-org": patch
---

The board no longer runs a synchronous `git remote get-url` when it looks up a clone's repository (A11-433). Every lookup now reads the origins that the sweep has just read asynchronously, and `agent-org doctor` reads them the same way. `src/ticket-mode/reviewer-port.ts` leaves `blocking-calls.baseline.json`.
