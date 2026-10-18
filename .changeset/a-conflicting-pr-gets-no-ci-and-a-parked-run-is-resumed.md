---
"agent-org": minor
---

A parked run whose pull request conflicts with its base is resumed now. A run that parked on a question (`needs-human`), or ended with no outcome or crashed, is not watched, so the board left its pull request alone. A conflict is a state the worker can clear by itself, so one that is CONFLICTING or DIRTY closes the parked workspace and queues a review round that resumes the same worker, which merges the base in. Its new feedback does not wake it: only a conflict does, and within the same cap of three rounds. A run the tracker completed or canceled, or whose pull requests all merged or closed, is left alone.

Review briefs also tell the worker what to do when no check has started on its head commit: read `mergeable` and `mergeStateStatus` first, and merge the base in when the pull request conflicts. GitHub runs no `pull_request` workflow on a conflicting pull request, so a worker no longer parks as "CI never started" and asks a person to re-run CI. The tests carry `A11-89` in their names.
