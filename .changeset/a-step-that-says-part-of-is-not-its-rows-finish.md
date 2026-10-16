---
"agent-org": patch
---

A pull request that is a STEP of a row, and says the row stays open, is no longer read as that row's deliverable. A `Closes: none` reason that names a row is the deliverable unless the same body also carries a `Part of` or `Refs` line naming that same row, so the daily pass stops filing `row-not-finishable` for a step (a11ign/agent-org#1550). A `Closes` list is read as before, and a row the step line does not name is still the deliverable.
