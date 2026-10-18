---
"agent-org": minor
---

The Pick view has an Assignee filter beside Projects, Priority, Plan and the label rows (A11-108). It chooses the signed-in person (the default, so the list is unchanged until the filter is used), Anyone, Unassigned, or each other person with an open ticket, each with its count. A ticket that is not in the signed-in person's own list shows its owner on its row, so it is not queued by accident, and the counter and the empty state name the chosen scope. The list is read once, with every open ticket's assignee, and filtered on the page, so no request is made per person. `tickets.pick` keeps its meaning and sets the default: a team or a project starts on Anyone. A tracker that cannot say whose key it is lists everyone's tickets, and says why in the row's title.
