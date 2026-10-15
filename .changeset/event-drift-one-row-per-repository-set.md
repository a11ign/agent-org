---
"@a11ign/agent-org": patch
---

A missed-delivery drift is one incident row per repository set, not one per reconcile window. A repository set that drifts again while its row is open joins that row, and one that drifts again within 24 hours of the row closing is folded into it rather than filing a second row (a11ign/agent-org#1330).
