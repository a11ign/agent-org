---
"agent-org": patch
---

A run that ended `needs-human` on a pull request's requested changes no longer stays at Needs you once that review is dismissed or approved with no new push and the pull request reads mergeable. The end of the run records which of its open pull requests were changes requested (`outcomeBlocks`), and the watch records whether each reads mergeable. When every blocked pull request that is still open reads a review other than changes requested at the head the run ended at, and every open pull request is mergeable, the run reads Awaiting review and its card says `the blocker cleared: the requested changes on a11ign/agent-org #1885 were lifted`, with the question still one click away. GitHub still computing whether it merges (`UNKNOWN`), a pull request not read yet, and a run that was not blocked on a requested change at its end clear nothing. The run stays parked until the pull request merges, which releases it as before.
