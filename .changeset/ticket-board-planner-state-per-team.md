---
"@a11ign/agent-org": patch
---

A planned ticket whose team has no state of the planner's name keeps its state, and its plan is still attached. Before, the board refused it and the run ended for a person, so a planner state such as "Planned" broke planning for every team that calls its unstarted state "Todo". The board's log now names the ticket and the missing state. `TicketSource.attachPlan` returns that note, or null when it did all it was asked.
