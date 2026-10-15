---
"agent-org": patch
---

A same-head re-fail reaches the owner a second time, behind `checks.sameHeadRefail` (agent-org#1185, half 2 of #1166), shipped OFF. A settled-red order's key named the head and not the run, so a rerun that failed the same way was the first failure's key and the delivered ledger dropped it; the owner was told once and never that the rerun failed too. With `agent-org machinery:flag on checks.sameHeadRefail --session=<you>`, a check that fails again at a head where an earlier run of it already reported a failure gets its own key (`.../<head8>/refail-<n>`), its order says it FAILED AGAIN, and the wake tick adds the failing assertion from the job's log. A head that has failed once, and every head with the flag OFF, keeps its key and its words byte for byte; a run that was only CANCELLED is not an earlier failure.
