---
"agent-org": patch
---

A reviewer that herdr will not start is no longer retried in silence. The board counts herdr's refusals per pull request head (in `reviewers.json`, so a restart keeps the count), says herdr's own reason on the pull request's line from the first, and reads the run that holds the pull request as Needs you on the second refusal in a row for the same reason, with that reason on its card. A different reason, a start that works, a new head, or a pull request that is no longer open takes it off. `agent-org doctor` has a `reviewer starts` row that fails with each pull request, its head, how many times it was refused, and herdr's reason. The board still tries again on every sweep, so a fix made elsewhere is picked up on its own (A11-241).
