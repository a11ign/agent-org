---
"agent-org": minor
---

Wake, the claim and the filing of rows no longer call GitHub from core: `src/wake.ts` and six files of `src/wake/`, `src/wakes-per-row.ts`, `src/row-claim.ts` and the six rule files of `src/row-claim/`, the three files of `src/row-file/`, `src/claim-stall/`, `claim-label-strip`, `claim-provenance`, `row-reachability` and `duplicate-row` ask the code host's `rows` (contract 1.10) for what they need, by name, implemented in `plugins/github/rows/`. Each operation builds the argument list the caller built, so the call census and the ledger see the same calls; the decisions stay in core. A claim's `gh` is the code host's own runner behind the leak guard, not the `run` its caller hands it (`run` is `git` and the board snapshot only), so a test of a claim seeds the fake code host. `docs/gh-call-baseline.json` goes down by 23 files. The fake code host's world gained `wake`, `claim`, `filing`, `rules` and `misc`.
