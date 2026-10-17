---
"agent-org": minor
---

A same-repository pull request with a `session:` label that the review-trust check classes OUTSIDE is now named, and its reader is woken when its not-convinced verdict says only that no CI Acceptance run is available (agent-org#1667). Both are behind `reviews.outsideSessionPr`, which is OFF by default, so nothing changes for a project that pins a tag until the flag is switched on. With the flag ON, a pull request classed OUTSIDE for ten minutes raises the org-health signal `session-pr-classed-outside`, which names the pull request, its author's login, its session and the minutes, and pages `ceo`. With the flag ON, a verdict whose only finding is the missing CI Acceptance run reaches the pull request's reader, while a verdict with any other finding is still withheld as before. The machinery canary's samples are unchanged.
