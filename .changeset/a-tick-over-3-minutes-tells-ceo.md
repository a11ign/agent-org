---
"agent-org": minor
---

A tick that runs over `TICK_SLOW_SECONDS` (180) or is killed by the timeout now tells `ceo` (a11ign/a11ign#3567). The slow one reports in its own tick, from its `tick-cost` line: wall (with `ExecStartPre`, which `TimeoutStartSec` also counts), CPU and the phase that took longest. The killed one is read by the NEXT tick: every tick writes `tick-running.json` beside the ledger and clears it whenever its process ends by itself, a crash included, so a marker still standing was left by a signalled process and is reported once with its start time and the most it can have run. One new cause, `tick-overran`, keyed per tick start. Known gap: a kill during `ExecStartPre` happens before the marker exists. `src/work-tick-health.mjs` is new.
