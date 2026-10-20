---
"agent-org": patch
---

A ticket whose Acceptance, Done-when or Open-check still leaves a decision open cannot be queued: Pick shows "Needs a decision" with the open line and disables its Select, and Grill settles the decision in a terminal and writes the answers into the ticket. A ticket that changes a screen also needs its behaviour grilled first. A worker never starts on such a ticket and never settles a product decision itself: it ends needs-human with the one question, and the planner's check refuses a plan that records a product decision as made without asking.
