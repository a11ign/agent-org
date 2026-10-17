---
"agent-org": minor
---

Behind `prs.ownerlessAsk` (OFF when absent), a pull request with no live `session:` label whose owner is `ceo`, `owner-gone` or the chairman is asked of `orchestrator` when it is red, ejected or hung, or approved and out of the merge queue past `UNQUEUED_MINUTES`, or when the queue ejected it green and it is kept as the owner's. Each order names the pull request, its owner source and the minutes. A pull request under `ceo` or `owner-gone` that is OUTSIDE the org is never asked. With the flag OFF nothing changes (agent-org#1671, split from a11ign/agent-org#1648).
