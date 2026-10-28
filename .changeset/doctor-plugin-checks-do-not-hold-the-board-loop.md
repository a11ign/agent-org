---
"agent-org": patch
---

The doctor hands the plugins a real asynchronous `execAsync` (A11-376). Before, it wrapped the synchronous `exec` in a promise, so each `gh` a plugin's health check ran from the board's thread held the board's loop for about half a second. On v0.331.0 that was 84 of 144 held-loop lines in 24 minutes.
