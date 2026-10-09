---
"agent-org": patch
---

`org-health` no longer prints `class-repeat UNKNOWN -- unknown class` every tick for the failure ledger's two counters, `unclassified` and `unidentified-caller-order` (written by `prompt:session` per order). `groupByClass` leaves them out, so they are neither a stranger nor a candidate for a `Failure class … repeated` row; a ledger key that is neither indexed nor a counter is still a stranger and still reads `UNKNOWN`. a11ign/a11ign#4618.
