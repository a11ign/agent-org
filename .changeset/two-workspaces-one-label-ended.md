---
"agent-org": patch
---

A reviewer instance's ending closes EVERY herdr workspace under its label, not only a label held exactly once (a11ign/a11ign#3482; `reviewer-3460` held `w16B` and `w16N` on 2026-10-04, and the teardown said "left running" on every tick for as long as both lived). Each close is tried even after one fails, a failing close keeps the instance registered, and the warning names the count. A duplicate that holds no agent no longer stops the instance's OTHER workspace from being judged between turns, and no longer makes a live reviewer look dead under an open pull request. That duplicate is written once to the `reviewer-absences` ledger (`duplicate-agentless`), so it is seen while the pull request is still open.
