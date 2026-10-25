---
"agent-org": minor
---

A pull request the merge queue removes is answered by the board (A11-264). A removal for failed checks starts a fix round whose brief names the failing job and step and their error lines from the `merge_group` run, and says the failure is on the merged result; a removal for a conflict starts a conflict round; any other reason is named on the card. A pull request removed three times for failed checks with no push between is held from the arm bot with the label `hold:board` and the card says "removed from the merge queue 3 times: <job>"; the label is lifted when its head changes. The code host contract is 1.21: `PullFeedback.queue`, `readQueueFailure` and `holdFromQueue`, all optional, so a plugin of 1.20 behaves as before.
