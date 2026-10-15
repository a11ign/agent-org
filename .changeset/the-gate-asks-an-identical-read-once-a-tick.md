---
"@a11ign/agent-org": patch
---

The work gate answers a `gh` read it has already made in the tick from memory instead of asking GitHub again (a11ign/agent-org#1095). A tick made 567 to 745 calls, the same `pr list --state merged --limit 100` eight times, and ran out of its 300 s (`GATE OUT OF BUDGET`) before it printed an order, spending the primary rate limit on its own repeats. The memo is held by the gate process alone and keyed by repository and argv; a refused read is never kept, and any call that is not a read forgets every answer. The tick ends with one `read memo:` line saying how many reads it answered from memory.
