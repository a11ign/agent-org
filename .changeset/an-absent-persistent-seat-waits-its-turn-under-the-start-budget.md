---
"@a11ign/agent-org": patch
---

After a herdr restart, the tick's `seats` phase starts every absent persistent seat one after another, and each `herdr agent start` can wait its full 30 s. The starts now share the tick's start budget (a11ign/agent-org#1025), so a seat whose start would begin after the budget is spent is left absent and reported as `SEATS DEFERRED`, and the next tick starts it (a11ign/agent-org#1052). A restart of many seats no longer holds the `wake` phase for N x 30 s.
