---
"@a11ign/agent-org": patch
---

`host/gh` can refuse a reviewer's call when the reviewer App's token cannot be minted, and say why on stderr: the alternative posts the review as the account (`a11ign-bot`), which counts as the human's approval on `main`. The refusal ships behind `AGENT_ORG_REVIEWER_REFUSAL=1`, OFF, so a failed mint falls back to the account as it did before, until the reviewer's token cache is writable (a11ign/agent-org#1399, a11ign/agent-org#1347, ruled on #1343). Every other role still falls back to its account.
