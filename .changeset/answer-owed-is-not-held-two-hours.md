---
"agent-org": patch
---

`answer-owed` is an `ACTION` cause, not a `JUDGMENT` one (a11ign/a11ign#3652). A delivery held its causeKey for two hours even when the `answer:<session>` label had been removed and applied again, and the key carries no label time, so a question labelled inside that window never woke the session it named (`product-manager/answer-owed/row-3566`, four deliveries two hours apart and none at a label time). It now takes the documented twenty-minute cadence. A label that stands unanswered is offered every twenty minutes and trips `MAX_DELIVERIES` about two hours in.
