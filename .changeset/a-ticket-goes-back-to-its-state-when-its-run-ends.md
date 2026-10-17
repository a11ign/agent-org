---
"agent-org": minor
---

Ticket mode puts a ticket back in the tracker state it had before the board moved it to `tickets.workingState`, when its run ends without a pull request: a run that is stopped, crashes or checks its ticket, a queued run that is removed, or a parked run that is dismissed. Before, such a ticket stayed "In Progress" in the tracker with no run doing the work. A run that needs you keeps its ticket In Progress while it is parked, and Dismiss puts it back. A person who has moved the ticket since is left to it, and a restore the tracker refuses is logged and tried again on the board's next refresh.
