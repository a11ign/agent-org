---
"@a11ign/agent-org": minor
---

The ticket board's Board tab is a runs view after GitHub's Actions runs: every run in one list with a status icon (a spinning ring while it works, a check once done, a cross when it failed), and a filter per status with its count. A run is Completed once the tracker completes its ticket, which Linear does when the ticket's pull request merges: `TicketSource` gains an optional `stateTypes` read, the Linear source answers it in one batched request, and the board asks every two minutes about finished runs whose ticket is still open.
