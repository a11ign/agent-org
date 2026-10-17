---
"agent-org": minor
---

Ticket mode no longer leaves a run stuck when its pull request turns conflicting after a sibling merges. The feedback watch reads each finished run's pull requests for a merge conflict (`mergeable` or `mergeStateStatus`, where GitHub says it, not while it is still computing), and a conflicting one resumes the same worker as a review round: the worker merges the base branch in (never a rebase, never a force-push), resolves each conflict keeping both changes, re-runs the checks, pushes, and replies saying which files conflicted. It counts toward the round cap of three, and a run already Ready to merge or awaiting review is reopened for it. Draft pull requests get no round.

Two queued runs in one repository that touch the same path no longer start side by side. A plan's `## Paths` section (`repo:path` bullets, a trailing `/` for a directory) and the files each open pull request changes make a run's footprint, and a queued run waits as Blocked, saying "Waits on A11-81 #1736: both touch pool.ts", until the run holding the path has its pull request merged or closed. Runs that share no path, and runs in different repositories, still start together. The planner's briefs ask for the `## Paths` section, and a batch planner orders tickets of one repository that touch the same area with `after` in `order.json`.
