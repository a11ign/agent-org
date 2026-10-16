---
"agent-org": patch
---

A ledger ref a person has read as NOT an occurrence of its class can now be left out of that class's count (agent-org#1551). The ledger is append-only, and `countedSince` drops every ref before a time, genuine ones with it, so a detector's false positive counted for ever and `class-repeat` ordered a guard post-mortem over it. A class in `.agent-org/failure-classes.json` may now carry `notOccurrences`, a list of `{ "ref": "<ledger ref>", "reason": "<why it is not the class>" }`: `class-repeat` leaves those refs out of that class only, and the ledger line stays as the record. Use `countedSince` when the guard fixed the defect, and `notOccurrences` when the ref was never the class. A `notOccurrences` that is not a list of non-empty `ref` and `reason` strings makes the index a stated gap, never a count that puts the false refs back.
