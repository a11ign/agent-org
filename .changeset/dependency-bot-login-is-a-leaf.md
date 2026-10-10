---
"agent-org": patch
---

`DEPENDENCY_BOT_LOGIN` lives in `src/dependency-bot-login.ts`, a leaf module that imports nothing, instead of in `src/work-gate/pr-orders.ts` (a11ign/agent-org#705). `pr-orders.ts` imports from `../work-gate.ts` (the cycle its header describes) and `failure-recorders.ts` keeps the work gate out of the hand-fix ledger's writer set on purpose, so the ledger could not share the pattern with `isDependencyBotPr` from there (a11ign/agent-org#560). `pr-orders.ts` re-exports the name, so every reader of it from there is unchanged and no behaviour moves.
