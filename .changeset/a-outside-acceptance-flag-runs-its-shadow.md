---
"agent-org": patch
---

With `outside.acceptance` on and `A11IGN_PR_ACCEPTANCE_BY_GATE` off, the work gate runs the acceptance shadow: each eligible pull request's acceptance verdict is computed and logged as `outside-acceptance: SHADOW #n …; blocks nothing.`, beside the job's verdict (`unread` when there is no `acceptance` check run). Before, nothing read `outside.acceptance` (agent-org#1612). A guard shadow no longer skips the real acceptance gate when `outside.guards` is on. With the flag absent or false, nothing changes.
