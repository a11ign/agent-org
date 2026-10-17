---
"agent-org": minor
---

Ticket mode's board: a finished run can be dismissed. Dismiss takes the run off the board and closes its workspace, and keeps the ticket, its branches and its pull requests. A run whose ticket is closed in Linear, or has become a parent of sub-issues, is offered Dismiss with the reason; nothing is dismissed on its own. A run that ends `needs-human` closes its workspace once its outcome is recorded, and Retry resumes its Claude session with the reason it gave. `wrong-repo` and a run with no outcome still park their workspace.
