---
"agent-org": patch
---

The board no longer logs a verdict for a pushed head no reviewer saw, and starts the reviewer for it (a11ign/agent-org, A11-340). A head's recorded review (`PullHead.review`) reads `none` for a head with no review at that commit: GitHub's review decision follows the pull request and stays `CHANGES_REQUESTED` after a push, so it had put the earlier commit's request on the new head, logged a `verdict` for it, and raised the "has sat changes requested" Needs-you card against it after 30 minutes. A cancelled run of a check that has another run at the same head is a duplicate and no longer keeps `settledGreenOf` from reading the head as settled, so the reviewer starts for it; a check whose only run was cancelled, or whose other run is running or red, still does not settle.
