---
"agent-org": patch
---

The `tick-cost` line gains `phaseCalls` (a11ign/a11ign#3566, slice 7): for the calls the tick's own process starts inside a phase (`tearDownSpares`, `tearDownReviewers`, `recover`, ...), the same count and wall per `<program> <subcommand>` that `subcommands` gives for the whole tick, so the 8 to 10 s the two teardowns take can be read as the calls that make it. A census record carries the phase the meter had set when the child started; the meter sets it around each step and clears it in a `finally`, so a throwing step cannot leave a stale name. The gate's and the wake's own children are another process and stay counted whole-tick. Nothing in the tick changes: no new call, no new order.
