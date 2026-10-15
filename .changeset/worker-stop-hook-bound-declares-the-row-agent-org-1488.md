---
"agent-org": patch
---

The `worker:stop-hook`'s bound now routes the row it bounded: at the third refusal in a row for a claimed row with no pull request and no declaration, the hook makes the `blocked` declaration its refusal names, through `worker:state blocked`'s own path (the row carries `answer:product-manager` and the reason). Before, the bound only wrote a `stop-hook-bound` ledger line and routed nothing, so the row stayed claimed, undeclared and silent (a11ign/agent-org#1488, a11ign/a11ign#5478). A declaration the row cannot take is said on stderr and the stop is still allowed.
