---
"@a11ign/agent-org": patch
---

The tick's standing record row is created with `lane:ceo`, `backlog` and `out-of-release` instead of `lane:ceo` alone, so the gate's `settleOffBoardRows` boards it at Backlog and `row-off-board` no longer asks a manager for a Status the sanctioned `row-file --board` refuses a standing record. a11ign/a11ign#5275, agent-org#1229.
