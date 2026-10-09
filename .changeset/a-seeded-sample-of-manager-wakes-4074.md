---
"agent-org": minor
---

`src/trace/triage-sample.ts` draws a SEEDED, reproducible sample of 100 manager wakes (`ceo`, `product-manager`, `orchestrator`) for a human to label `wake`, `digest` or `drop` before any model triages one (a11ign/a11ign#4074, #4055 move 8, first step only). It is stratified by cause: every cause with a wake in the window gets a place, the rest are shared in proportion, and a cause with fewer wakes than its share contributes all of them; a window with more causes than places is refused. The sheet shows only cause, causeKey, session and the wake's cost (a floor when a turn is unpriced, `no turn` and never 0 when none ran), in a seeded shuffle, and none of bytes, delivery lag or time. Run `node src/trace/triage-sample.ts --seed <text> [--from <iso>] [--to <iso>]`; a run without a seed is refused. No model is called.
