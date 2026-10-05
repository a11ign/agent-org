---
"agent-org": patch
---

The gate no longer reads every Claude transcript on the host to count a row's calls. `liveClaudeTurns` skips a transcript nothing has written to within a day (`LIVE_TRANSCRIPT_HORIZON_MS`), and reads one that has been touched whole. Measured on the live `~/.claude/projects`, 3.3 GB over 4,221 files: 50.2 s wall and 38.1 s CPU before, 3.6 s and 3.4 s after, at host load 42. The tick-cost census also stops recording an asynchronous `exec` twice, and `util.promisify(execFile)` resolves `{ stdout, stderr }` under the preload again. a11ign/a11ign#3566, slice 3 of the tick's cost.
