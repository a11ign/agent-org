---
"agent-org": minor
---

The `board-disagrees-with-reality` order can be keyed per (row, question) pair instead of on the whole set of disagreements, behind `orgHealth.boardTruthPairKey`, which defaults OFF. The set key meant one new disagreement anywhere on the board changed the key and offered every standing disagreement again: on 2026-10-16 the journal holds 32 such offers under 31 distinct keys, while the distinct (row, question) pairs behind them number 36. With the flag ON, a pair is offered when it first appears, or when it returns after it has been off the board for more than 120 minutes (offered again as `:2`, `:3`, ...), and a pair that stands is not re-offered. The pairs are kept in `board-truth-pairs.json` in the state directory. With the flag OFF, the order is the set-keyed one it has always been.
