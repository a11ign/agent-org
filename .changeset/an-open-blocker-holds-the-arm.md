---
"agent-org": patch
---

A pull request whose closing row still has an open `blocked-by` edge is not armed, and the refusal names the blocker. `arm-pr` and `auto-arm-sweep` both ask one decider, `blockerVerdict`, after the authorship and ejection checks and before any write: it reads each `Closes` row's native `blockedBy` (in the row's own repository for `Closes owner/repo#n`), counts only OPEN blockers, and names every blocked row with its open blockers. A list that cannot be read, or whose `totalCount` exceeds the page returned with no open node on it, is `cannot-ask` and arms nothing, as an unreadable label list does. `Closes: none` has no row to read and arms as before. The PR gets one comment, found again by a marker so a tick does not repeat it, saying it arms on the tick after the blocker closes. `refusalBeforeArming` now takes the PR's body (a11ign/a11ign#3544).
