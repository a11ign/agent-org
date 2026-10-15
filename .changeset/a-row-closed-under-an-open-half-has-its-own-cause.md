---
"@a11ign/agent-org": patch
---

The order that says a row closed under an open half of itself carries its own cause, `row-closed-under-open-half`, instead of reusing `ready-row-unclaimable`. That cause keeps its one meaning, a refused claim, so the trace and the seats' routing no longer read a closed row as a refused one (agent-org#1060). The order is still said once per (row, half), and its record and its routing identity are unchanged.
