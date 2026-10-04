---
"agent-org": patch
---

The outcome clock names a claimed row for the two idle shapes it could not tell from a row being worked (a11ign/a11ign#3486, slice 2b): `wait-premise-gone` (its holder idle on a `Not-before:` that is in the past, #3131) and `never-started` (no commit, push or comment, no pull request, its holder idle, #3495). The reading is `idleClaimantReading` over the claim-stall tick's moves (`decideArgs.claimFacts`) and herdr's listing, read only when a claimed row is untouched past `OVERDUE_IDLE_CLAIM_MINUTES` (80, measured). A busy holder, a wait that still holds, a pull request that owns the row and a young claim name nothing; a refused or partial herdr listing is reported unread, never as clear. The rows are still RAISED at the 135-minute row bound: `boundOf` reads one bound per kind and lives in `org-health.mjs`.
