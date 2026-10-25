---
"agent-org": minor
---

A person's answer to a run that asked them a question now reaches the ticket: `POST /api/queue/<KEY>/answer` with `{ "answer", "who"? }` writes the run's question and the answer into the ticket's description under `## Decisions (<who>, <date>)`, through the tracker plugin, and then sends the answer to the waiting run. A worker's brief says to read the ticket's Decisions before the plan and to link the Decisions entry whenever it tells a pull request that a person decided something. A planner's plan for a ticket with Decisions carries a `## Ticket decisions` section, and a plan that states a `Conflicts:` or has no such section is not attached. A run may not name the board's key or a queue action route in a command. `docs/answering-a-run.md` has the call.
