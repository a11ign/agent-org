---
"agent-org": patch
---

A review whose `state` is `DISMISSED` is no longer the standing verdict. `verdictBearers` (`src/review-verdict.ts`) read a review's body and never its state, so a refusal that had been ruled wrong and dismissed stayed the newest verdict at its head: `settledVerdictOrder` kept ordering the author to rework what the ruling said was not owed (`verdict-not-convinced`, 48 STUCK lines in 3 h on agent-org#579), and the no-verdict path that asks for a fresh review never fired. A review with no `state` field still counts, and a refusal that is not dismissed (`CHANGES_REQUESTED`) still reads `not-convinced`.
