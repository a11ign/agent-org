---
"agent-org": minor
---

The Tickets page can show each ticket's readiness score (A11-443, step 1 of 2), behind the new `tickets.readiness` setting, which is off by default. When it is on, a cheap model (haiku, with no tools) scores each listed ticket from 0 to 100 on whether it has acceptance criteria, a clear scope and a named repository. The score is kept by the hash of the ticket's description, so a ticket is scored again only when its description changes, and a failed call is not tried again until then. A score under 60 shows its reasons and an "Improve with the writer" button, which opens the New ticket dialog filled in with the ticket and its reasons; nothing is sent until the person sends it. The score never holds a ticket back from the queue.
