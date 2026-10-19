---
"agent-org": patch
---

The ticket board no longer holds a queued run for another ticket's `.acceptance/` or `.changeset/` files, which are named by ticket, so two tickets in one repository start together when their source files differ. A pull request whose file list was cut short holds only the files it listed, and a queued run that touches none of them starts. The board shows such a cut list as a note on the queued run, and still names the path and the ticket when a shared source file holds a run back.
