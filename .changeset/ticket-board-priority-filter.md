---
"agent-org": minor
---

The ticket board's Pick tab filters by priority: Urgent, High, Medium, Low and No priority, each with its count, several at once, remembered in the browser. A priority keeps the epic above a ticket it keeps, as the plan filter does, and an epic's own priority does not decide it. `visibleTickets` in `board-view.ts` now takes its filters as one object.
