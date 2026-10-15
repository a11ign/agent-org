---
"@a11ign/agent-org": patch
---

A claim command run from a copy of `src/` outside a git work tree is the stale-rule guard unable to ask, not a failed claim: its `CANNOT ASK whether this checkout's copy of the rule is current: <dir> is not inside a git work tree` refusal is written as `claim-guard-held`, with no class and no repeat, and still counted by signal 26 through `readClaimRefusals` (agent-org#1458). Every other `CANNOT ASK` refusal of the rule's copy stays `claim-refused`.
