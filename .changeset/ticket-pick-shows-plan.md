---
"agent-org": minor
---

The ticket board's Pick tab marks a ticket that has no plan of its own, on a machine that names in the new `tickets.plan` the pattern a plan's file name matches, such as `"-plan-[^/]*\\.md$"` for NBL's create-ticket. A worker briefed without a plan starts without the agreed approach, so the mark shows which tickets need one first. It is muted when the ticket's parent has a plan, because a worker is briefed with its parent's plan too. An epic is never marked or counted, because no worker starts one. A Plan filter, with counts, shows only the tickets with a plan or only those without, each still under its epic, and is remembered in the browser. The names of each ticket's uploads come back with the list of tickets, in the same request to Linear, so the Pick tab makes no extra calls.
