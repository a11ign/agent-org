---
"agent-org": patch
---

The board-truth audit's `closing-pr-merged` question no longer raises an open row whose closing pull request merged less than five minutes ago (`MERGE_GRACE_MS`, the filing grace's length; a11ign#4116, four transient trips on 2026-10-08 for a row GitHub closes a second after the merge). Both merged-PR reads (the first tracker's and each code repository's) now ask for `mergedAt`. A withheld row is counted, and the table prints `N merging, not judged` beside the count only when N is above 0. A PR merged longer ago, one that carries no readable `mergedAt`, and a row a settled PR also closes are raised exactly as before.
