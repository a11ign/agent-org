---
"agent-org": patch
---

New ticket has two modes and no review screen (A11-124). Quick runs unattended and the board creates the ticket from each draft when the run ends; Grill opens the run's terminal at once, the writer asks its questions there one at a time, and the board creates the tickets when the grilling ends. The draft-review view and its Approve, Approve and queue and Discard buttons, and their routes, are removed: a person creates nothing by approving a draft. The instruction in `tickets.writer.run` no longer names a mode, because the board passes the mode to the run (`{mode}`, or the brief). Duplicates the writer found are named in the new ticket's description. A run an older board left for review is failed, and no ticket is made from its drafts.
