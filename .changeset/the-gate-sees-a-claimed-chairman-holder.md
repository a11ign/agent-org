---
"agent-org": patch
---

The gate's chairman set now includes CLAIMED chairman rows: `offerHierarchyNow` verifies `priority:chairman` on the open `in-progress` rows as well as the Ready ones (`readChairmanPriorityOfOffer`), so `overlapVerdict` sees a claimed chairman holder and two chairman rows over one file are not both offered. A claimed holder's label added by another login is ignored and an unreadable history fails closed, as for a Ready row; a chairman row over a claimed plain row is still offered. a11ign/a11ign#4800.
