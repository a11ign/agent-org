---
"@a11ign/agent-org": minor
---

A queued ticket-mode run waits while a ticket that blocks it in the tracker is not done, and starts once it is: when the tracker completes the blocker, or, for a blocker on the queue, once its run is Completed, which its pull requests merging is enough for. The board shows such a run as Blocked, with its own filter and the tickets it waits on, and it holds no slot, so a run queued later with nothing blocking it starts first. A canceled or duplicate blocker never lets go. Linear's "blocked by" relations are read through a new optional `blockers` on the ticket source, before a run first starts and again every two minutes, and nothing starts while the tracker cannot say. A run that waited names its blockers and their pull requests in its brief, and is told to check that a release it depends on is out before relying on it.
