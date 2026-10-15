---
"@a11ign/agent-org": patch
---

A `claim-stalled` nudge is no longer typed for a holder whose own pull request is open and not red (a11ign/agent-org#805). An open pull request means the holder is working, so the claim reads `pr-owned`, not idle, and the young-pull-request regime that typed nudges for it is removed. The red-check nudge (`redCheckNudgePrompt`) is kept: a red own pull request is the one exception the #1151 ruling names. A held pull request (`hold:` label) is still not dropped from the `blocker-cleared` own-pull-request check, as before (#2493). A `blocker-cleared` order for a row in the other tracker (a11ign/agent-org) can still type after its pull request opens; that is a11ign/agent-org#1162.
