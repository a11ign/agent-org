---
"agent-org": patch
---

`trace` and `trace --aggregate` price every stored turn from `PRICES` as it stands when they READ it (`repriceEvents`, `src/trace/store.ts`), not from the `costUsd` the line carried when it was ingested. The store is append-only and an unchanged transcript is not read again, so a price added later (the Sonnet 5 and Opus 5 rows, a11ign/a11ign#3582) never reached the turns stored before it: 147,675 turns kept `costUsd: null` and two weeks of the aggregate printed no dollars. A model with no price (the Codex model, `<synthetic>`) stays `null` and its row stays a floor; the stored lines are not rewritten. The waterfalls, `--map` and `--wake-cache` read the same repriced events. a11ign/a11ign#3638.
