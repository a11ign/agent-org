---
"@a11ign/agent-org": patch
---

A `ci-shared-failure` incident row the gate files is boarded when it is filed: it is on Project 1 at Status `Backlog` with the `out-of-release` and `backlog` labels, so `row-off-board` no longer orders product-manager to board a row that has no Region or Acceptance (a11ign/a11ign#5405). A board step that fails leaves the row not filed, and the next tick joins it and boards it. The incident body says it is a signal for `orchestrator` and carries no claimable work.
