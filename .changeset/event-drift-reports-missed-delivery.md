---
"@a11ign/agent-org": minor
---

In `webhook` mode a repository due for its reconcile is probed once, and a probe that moved with no event behind it files one incident per repository per window as a missed delivery (agent-org#982, a11ign/a11ign#5043). `"source": "poll"` is the revert.
