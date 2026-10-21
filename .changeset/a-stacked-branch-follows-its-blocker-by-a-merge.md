---
"agent-org": patch
---

A stacked run follows its blocker's moved branch by a merge, not a rebase: agent-org merges the blocker's branch into the run's own branch and pushes it plainly, with no force-push. A merge that conflicts is aborted and starts the run's conflict round, which merges the base in and resolves it, instead of handing the run to a person with "a person resolves it" (A11-150). The board shows "Resolving a conflict with NBF-1 in <file>" meanwhile, and past the round cap it names the cap.
