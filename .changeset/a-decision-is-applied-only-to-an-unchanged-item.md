---
"@a11ign/agent-org": patch
---

`src/decision-run/apply.ts`: `applyDecision` posts a decision and changes state through the ticket port only when the item reads back, has no event newer than its brief, and the answer is allowed; `leaseItem` / `releaseItem` hold one run per item for at most 10 minutes. agent-org#901.
