---
"@a11ign/agent-org": patch
---

`pr:open create --draft` is refused unless the body carries a `Draft-because: <reason>` line, before the Acceptance runs and before anything is sent. #4968 made READY the default, and workers still passed `--draft` themselves ("because it is control-plane product code"): a11ign#5035, agent-org#949 and control#51-#54 were open drafts at 12:40Z on 2026-10-11, each a wait with no purpose, since the reviewer and the merge queue are the gate. The refusal names the remedy (drop `--draft`, or say why in one line). `edit` has no `--draft` and is untouched. a11ign/a11ign#5036.
