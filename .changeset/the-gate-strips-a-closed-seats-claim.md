---
"agent-org": patch
---

The work gate takes the claim labels off a CLOSED row whose only listed holders are standing seats once it has been closed more than 24 hours. A standing seat is always listed, so the #3883 rule (a listed holder keeps its closed row) kept a seat's closed row for ever and the gate said `keeps its claim labels` on every tick, until the repeating-lines check ordered the seat. A row closed within the day, a row with a listed `worker-<n>` holder, and a row with a missing or unparseable `closedAt` are still kept. `readClosedClaimLabelRows` now reads `closedAt`. a11ign/a11ign#3900.
