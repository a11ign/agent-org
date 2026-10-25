---
"agent-org": patch
---

A `Partial:` line that says nothing remains (`none`, `nothing`, `n/a`, `last step`, `nothing remains` and the like, in any case) is refused by `pr:open`'s and CI's `closes` report, which tell the worker that the last step closes the ticket: write the closing keyword and the key, and no `Partial:` line. The board reads such a line in a merged pull request as `Closes`, so the ticket is completed and the card shows no partial merge (A11-239). On agent-org#1877 (A11-219) the body said `Partial: none; this is the last step.` and the ticket stayed In Progress.
