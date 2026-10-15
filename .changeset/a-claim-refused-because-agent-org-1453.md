---
"@a11ign/agent-org": patch
---

A claim refused because another session already holds the row (`is already claimed by`), or because its `Waiting-for:` is not yet true, is the claim guard working: it is written as `claim-guard-held`, with no class and no repeat, as the worktree cap, a B4 overlap and the rate limit already are (agent-org#1453). Every refusal text `row-claim.ts` builds is now listed once beside its kind in `CLAIM_REFUSAL_TEXTS`, and a refusal added without a kind turns `src/row-claim-refusal-kind.test.ts` red.
