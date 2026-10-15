---
"@a11ign/agent-org": minor
---

`agent-org machinery:flag on|off <name> [--signals=a,b] --session=<you>` turns a machinery flag on or off, and `machinery:flag list` shows each flag with who set it and when (a11ign/agent-org#1061). The record is written through `withMachineryFlag` into `machinery-canary.json`, the one the gate's readers consult. A name no module reads, a signal the tick does not record, and a state file that does not parse are refused with nothing written. `off` clears a `reverted` verdict, so a flag the canary turned off can be tried again.
