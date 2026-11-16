---
"agent-org": patch
---

`agent-org ticket:pair` now runs the worker terminal's pairing program with an async spawn instead of `spawnSync` (A11-433). The command exits with the same status as before. When the program cannot start, the error now names the call as `spawn` where it named `spawnSync`. `src/ticket-mode/pair-command.ts` leaves `blocking-calls.baseline.json`, so the lint ban now covers it.
