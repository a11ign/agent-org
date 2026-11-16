---
"agent-org": patch
---

The board's merge of a blocker's moved branch into a finished stacked run first brings the run's worktree up to its own branch on the remote, when the remote is ahead and holds every commit the worktree has. Anyone else's push to the run's branch (a person, the code host's update, another clone's merge) left the worktree behind, and the merge made on the stale head was refused by the remote on every sweep until the run was parked as Needs you ("the merge of A11-435 was refused by the remote", #2059, 82 commits behind). A worktree holding a commit the remote does not have is left as it is, so that push is still refused and nothing is overwritten or dropped.
