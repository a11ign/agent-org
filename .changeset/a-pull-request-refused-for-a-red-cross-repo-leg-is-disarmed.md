---
"@a11ign/agent-org": patch
---

A pull request refused for a red cross-repo leg is disarmed, not only commented on. `runArmPr` now runs `gh pr merge --disable-auto` on a `cross-repo-red` verdict, reads the auto-merge request and the merge-queue seat back, and reports the outcome (`disarmed`, `already in the queue` or `already merged`) on the marker comment's first line and in the log. A queued pull request is dequeued through the existing dequeue primitive; if the dequeue fails, or the pull request is still armed after the write, the run exits `CANNOT_ASK` and the comment names the command to run by hand. `open-blocker` and `ejected` refusals are unchanged. agent-org#1278.
