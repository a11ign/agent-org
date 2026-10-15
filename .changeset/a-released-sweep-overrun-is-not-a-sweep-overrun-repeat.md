---
"@a11ign/agent-org": patch
---

A sweep that overran its 60-minute CI box and was released by the guard is no longer counted as a `sweep-overrun` repeat. The release is recorded once as `sweep-window-released`, a counter with no class and no repeat, and the row keeps its overrun comment. `sweep-overrun` is written only for a claim refused on that Region after the overrun notice, with the refused row as the ref (agent-org#1314).
