---
"@a11ign/agent-org": patch
---

The work-tick spawns the gate with a wall budget, `GATE_BUDGET_MS` (five minutes, under the unit's `TimeoutStartSec` of 600 s with `WAKE_ROOM_MS` left for the steps around it), where it had no deadline at all. One slow read used to spend the whole unit timeout and the tick yielded nothing, with no line to say which read it was in (a11ign/agent-org#1080). A gate killed at its budget writes one journal line, `GATE OUT OF BUDGET`, naming the unfinished read on this tick's census and how many reads had finished. The whole order lines it printed before the kill are handed on to `wake` as a partial result; if it printed none, the tick ends `CANNOT ASK` and still records its completion, so `incident:gate-crash` does not read a budget stop as a crashed tick.
