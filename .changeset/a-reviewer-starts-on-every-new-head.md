---
"agent-org": patch
---

A reviewer now starts on every new head of every open pull request the org holds, once its checks settle green, whatever state its run is in: running, `needs-human`, or no run at all, and whoever opened the pull request. Before, only a pull request of a run that ended ready was reviewed, so a fix pushed after "changes requested" was never re-reviewed until `ticket:review` was run by hand. A head with a reviewer or a posted review is still never started twice. `ticket:review` records what it starts in the memory file the pool reads, and says when a head is already reviewed or already has a reviewer. The board shows each open pull request's review state at its current head, beside a run's question, and lists a pull request no run has in a "Pull requests" section.
