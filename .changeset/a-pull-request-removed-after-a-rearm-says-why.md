---
"agent-org": patch
---

A pull request the board put back in the merge queue, which the queue then removes for a conflict or a person dequeues, now says why on its card ("removed from the merge queue by <who>: <reason>") instead of sitting out of the queue with no line (A11-437). The merge queue's rules are now part of the pure pull-request state machine, with property tests that check every such wait shows a reason.
