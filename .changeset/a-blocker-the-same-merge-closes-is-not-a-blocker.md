---
"agent-org": patch
---

`blockerVerdict` (`src/arm-pr.ts`, asked by both `arm-pr` and `auto-arm-sweep`) no longer counts an open blocker that is itself one of the rows the same pull request closes. A PR that closes both #4305 and #4372 where #4305 carries a native `blocked-by` edge on #4372 was refused for a wait whose only exit was its own merge (a11ign/lab#39 deadlocked, and the edge was removed by hand). The blocker is matched on the closing row's repository and number: a blocker number belongs to the row's own tracker, so a bare `6` on a row in the PR's repository is not `a11ign/a11ign#6`. A row blocked by an open row the PR does not close is refused as before, naming only the blockers that remain, and the unreadable-row `cannot-ask` verdict is untouched. a11ign/agent-org#470; epic a11ign/a11ign#4437.
