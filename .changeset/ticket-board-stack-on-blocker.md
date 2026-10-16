---
"agent-org": minor
---

A queued ticket-mode run now starts on top of a blocker that has an open pull request, a draft included, in the repository its planner recorded for it (`plannedRepo`, set when the ticket was planned in a batch). Before, it waited for that blocker to be done. The board shows such a run as Queued, with "Stacked on <KEY> #<n>". Its brief names each such blocker's pull request and branch. It tells the worker to make its worktree from that branch with the new `ticket:worktree <repo> --from <branch>`, and to run `gh stack link <blocker's pull request> <its own>` after opening its draft pull request. The rule applies to every "blocked by" in the tracker, whoever recorded it. A run with no planned repository, or a blocker that has no open pull request in that repository, still waits. The tracker's blockers now carry their `branch`, read from Linear's `branchName`. The hook allows `gh stack link` and refuses every other `gh stack` command.
