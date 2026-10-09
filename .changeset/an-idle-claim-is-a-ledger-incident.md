---
"agent-org": minor
---

The daily retrospective reports a claim that sat idle more than 60 minutes with no open pull request, or whose pull request has nothing pending (no check running, no reviewer asked, not approved, no evidence label, no hold), as a `row-not-finishable` incident: it prints the count and the first three refs, and records each in the failure ledger once per idle run. The idle decision is `idleClaimantReading`'s own, so a holder with a declared wait is never one, and the threshold is the named `IDLE_CLAIM_INCIDENT_MINUTES = 60`. a11ign/a11ign#4642.
