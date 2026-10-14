---
"agent-org": minor
---

The ticket board can move a ticket to a working state as a worker starts implementing it. On a machine that sets the new `tickets.workingState`, such as "In Progress", a ticket not yet started, a planned one included, moves there when its run starts, through the new `TicketSource.moveToWorkingState`, which Linear implements. A ticket already started or finished stays where it is, and a planning run moves nothing. A team with no state of that name keeps the ticket's state, and the board's log says so, as it does for a move the tracker refuses; neither stops the run.
