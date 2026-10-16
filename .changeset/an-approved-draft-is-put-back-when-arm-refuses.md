---
"agent-org": patch
---

The outside arming pass puts an approved draft back to a draft (`gh pr ready --undo`) when it readied it and `arm-pr` then refused, so the refusal no longer leaves it ready and unarmed (agent-org#1628).
