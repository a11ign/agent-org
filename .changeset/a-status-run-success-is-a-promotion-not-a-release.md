---
"@a11ign/agent-org": patch
---

The release-failure alarm (`failureStreak`, signal `release-run-failed`) no longer counts a `status` run's success as a release, so two failed pushes followed by a promotion read as a streak of 2, not zero. A `push` success still clears the streak. A `workflow_dispatch` success clears it only when that run's `release` job published (`releaseJobPublished`, read from the run's jobs); a dispatch that only promoted an existing tag does not. a11ign/agent-org#1273.
