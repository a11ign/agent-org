---
"agent-org": patch
---

A run at work whose worktree has commits holds the files those commits change, not its whole repository (A11-452). On 2026-11-16 A11-444 committed and then waited for a maintainer before pushing, and A11-450, which touched two other files, was held with "files not known" for as long as that wait lasted, with free slots. The board now reads `git diff --name-only <default branch>...HEAD` in the worktree of each run at work that has no pull request (`readCommittedFiles`, beside the pass and never waited for, again every 25 seconds while a run is queued in its repository), records it as `committedFiles`, and the run holds those files with its plan's paths. A queued run that shares none of them starts. A run with no commit yet, or whose worktree cannot be read, holds its whole repository as before.
