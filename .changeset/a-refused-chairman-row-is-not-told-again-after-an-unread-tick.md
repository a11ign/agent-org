---
"agent-org": patch
---

A refused chairman row `ceo` has already answered is no longer told again as a first telling after a tick that did not read the primary's Ready rows (a11ign/agent-org#1545, a11ign#4405). The refusal ledger forgot a row whenever the tick's shelf did not contain it, and a tick that did not read the lane shows an empty shelf: `decide` now passes `primaryUnread` (a refused or event-gated primary read) to `hierarchyOrders` as `laneUnread`, and on such a tick the ledger keeps its entries and a blocker is not read as closed. A tick that read the lane and did not refuse the row still forgets it, so the next refusal is a first telling as before, and a changed reason or an unwritable ledger is told as before.
