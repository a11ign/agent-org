---
"agent-org": minor
---

Ticket mode no longer queues a parent ticket (A11-76). The Pick list's read carries each ticket's open sub-issues (Linear `children`, not completed, canceled or a duplicate) in the same request, as `Ticket.children` on the tracker-agnostic source port. The page marks a ticket with open sub-issues as a parent, counts them and gives it no checkbox; it offers "Queue its children" instead, which calls the new `POST /api/queue-children` (also passed on over SSH and https by `remote-proxy.ts`). That route queues the open sub-issues in their "blocked by" order, or in identifier order with a note where the tracker gives none. `POST /api/queue` refuses a parent with a 400 naming its open sub-issues (`refuseParents` in `queue.ts`). A ticket whose sub-issues are all done or canceled is an ordinary ticket again.
