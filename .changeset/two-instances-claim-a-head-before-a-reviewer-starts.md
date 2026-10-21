---
"agent-org": minor
---

Two instances on one project start one reviewer per new head. Before a reviewer starts, the instance claims the head on GitHub with a commit status `agent-org/review` that names the instance and the time; an instance that finds another's live claim starts nothing, and `ticket:review` says which instance holds it. A claim older than the 60-minute lease with no verdict is taken over, and the board says so. The verdict door sets the claim to the verdict when the review posts. The instance's name is the new `tickets.instance` setting, which defaults to the machine's host name.
