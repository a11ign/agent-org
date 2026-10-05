---
"agent-org": patch
---

The tick's spawn census reads each synchronous spawn's CPU, and the `tick-cost` line carries `hottest`: the 5 command lines that used the most CPU, beside `slowest`'s 5 by wall. A spawn's `cpuMs` is the move in the tick's `cutime + cstime` while it was blocked, so it includes the child's own children; `null` when `/proc` cannot be read. `childrenCpuMs` moves to `lib/spawn-census.mjs` (the tick re-exports it). It exists because the `wake` phase of a waking tick is 15 to 55 s of CPU and nothing yet says whose. a11ign/a11ign#3566, slice 4 (the profile first).
