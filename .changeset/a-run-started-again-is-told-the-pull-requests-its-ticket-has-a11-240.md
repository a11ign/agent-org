---
"agent-org": patch
---

The code host contract is 1.18: `pullsNaming(key, repositories)` is a new OPTIONAL operation that lists the pull requests of some repositories whose title or body names a ticket's key, with their state, and the GitHub plugin answers it with `gh search prs`. A plugin of 1.17 is read as one that cannot be asked. A work run (a retried or re-queued one above all) is now told, in its brief, the pull requests its ticket already has on the code host (the ones whose `Closes` or `Refs` line names the ticket): an open one with its head, its failing checks and its `Partial:` step, a merged or closed one with its state, and to continue from there. Respond on a run whose record holds no open pull request, such as one a restart's crash emptied, now queues a round on an open pull request the code host holds for the ticket, instead of being refused with "has no pull request open" (A11-240).
