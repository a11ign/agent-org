---
"@a11ign/agent-org": patch
---

`host/gh` refuses a reviewer's call when the reviewer App's token cannot be minted, and says why on stderr: it used to post the review as the account (`a11ign-bot`), which counts as the human's approval on `main`. Every other role still falls back to its account (a11ign/agent-org#1347, ruled on #1343).
