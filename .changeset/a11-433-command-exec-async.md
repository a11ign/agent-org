---
"agent-org": patch
---

`agent-org ticket:stack-live-check` and `node plugins/github/merge-flow-command.ts` now run `gh` through an async `spawn` instead of `spawnSync` (A11-433). The live check now drives `sweepRetargetsAsync`, the same retarget sweep the board runs, rather than its synchronous twin. Exit codes and output are unchanged. When `gh` cannot start, runs past its time or prints more than 64 MiB, the reason now names the call as `spawn` where it named `spawnSync`. `plugins/github/command-exec.ts` leaves `blocking-calls.baseline.json`, so the lint ban now covers it.
