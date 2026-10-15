---
"agent-org": patch
---

A pull request held on a declared wait is no longer ordered to rework a NOT CONVINCED verdict (agent-org#1466). The rework order was re-issued every tick for a PR carrying a `hold:*` label or an open `blockedBy` edge at its head, so `MAX_DELIVERIES` escalated it to `ceo` for a wait the tick had already read (a11ign#5496). The exemption is the one `failingChecksOrder` already takes for a red check on a held or waiting PR, and it ends the same way: the hold comes off, the edge closes, or a new head is pushed, and the order comes back on the next tick. A convinced verdict and the unreviewed-convinced order are unchanged.
