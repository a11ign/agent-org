---
"agent-org": patch
---

A stuck-cause row the tick filed in the primary's tracker is closed, with a comment naming the cause key, once its `answer:ceo` is removed (a11ign/agent-org#622). The row is filed `parked` + `answer:ceo` and removing the label is the answer, but only a label row had a reader of the removal, so a filed row stayed open `parked` with no wait and `board-truth-audit`'s `parkedWithoutConditions` named it to `product-manager`. The tick now finds a filed row by its title among the open `parked` rows and closes it when no `answer:` label is left on it; a row re-routed to `answer:<session>`, or moved out of `parked`, is left. The cause is not asked again: the key stays escalated, so it stays quiet until its causeKey changes or it stops being emitted, as `ALREADY ESCALATED` says (a filed row has no re-ask; the label row's `REASK_AFTER_MS` is for a label).
