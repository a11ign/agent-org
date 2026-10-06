---
"agent-org": minor
---

The gate's tick writes its last COMPLETION to one GitHub object, so something off the agents host can read it without an ssh into a machine that may be frozen: the Actions variable `GATE_LAST_TICK` of the project's tracker repository (the declaration's first), set to the same epoch milliseconds `work-tick-completion.json` holds. It is written once, from `finish()`, AFTER the file and only on a tick that reached the end of `main()` (never on a `CRASH`), so it means what the file means. A write that fails says one `HEARTBEAT NOT WRITTEN` line on stderr naming the repository and variable, and never changes the tick's exit: the reader then sees a stale value. The variable must exist already (`gh api -X POST repos/<tracker>/actions/variables -f name=GATE_LAST_TICK -f value=0`); the tick only overwrites it.
