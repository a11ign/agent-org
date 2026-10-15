---
"@a11ign/agent-org": patch
---

A claim on a row whose `Waiting-for:` line is unmet is refused before any write (`unmetWaitingFor` in `claim-stall.ts`, asked by `row-claim.ts`), so a claim the gate released on a declared wait is not taken again while the wait holds. A condition that is true, or unknown, is still claimable.
