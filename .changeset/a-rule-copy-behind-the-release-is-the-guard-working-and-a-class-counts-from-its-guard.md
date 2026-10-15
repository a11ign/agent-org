---
"@a11ign/agent-org": patch
---

A claim refused because this checkout's copy of the rule is behind the release is written to the failure ledger as `claim-guard-held`, the guard working, not as `claim-refused`, so it is no class and no repeat (agent-org#1316, a11ign/a11ign#5282). A class in `.agent-org/failure-classes.json` may carry `countedSince` (an ISO time): its ledger refs before that time are no occurrence, so a class whose guard was fixed does not repeat on the history of the defect it fixed. A `countedSince` that is not a time makes the index unreadable, a stated gap, never a silent count of everything.
