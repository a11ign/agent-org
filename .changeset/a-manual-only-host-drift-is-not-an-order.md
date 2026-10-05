---
"agent-org": patch
---

`hostDriftOrders` no longer orders `orchestrator` on a drift set whose findings are ALL `manualFix` (a11ign/a11ign#3703). Its only remedy is `host:install`, which writes no line of a person's `gh` login (#3643), dotfile or Codex trust grant, so the order was declined every tick and the stuck breaker logged `cannot be escalated` for 30 consecutive ticks (its subject is `host-units`, not a row). `host:check` still reports every such finding; a set holding one finding `host:install` can clear keeps its key and its full prompt. The cost, stated in the function's header: a new manual-only finding wakes nobody on its own.
