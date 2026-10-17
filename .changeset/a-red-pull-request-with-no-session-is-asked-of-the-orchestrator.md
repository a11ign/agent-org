---
"agent-org": minor
---

A red pull request the chairman opened with no session on it is no longer silent. Behind the new `prs.ownerlessAsk` flag (OFF when absent), its `pr-checks-failing` order goes to `orchestrator` instead of being withheld, where `prs.ownerRouting` used to hold every follow-up on it. With the flag OFF nothing changes. The health signal `ownerless-pr-unreached` counts such pull requests unreached for `UNQUEUED_MINUTES`, and is watched once the flag is switched on (a11ign/agent-org#1648).
