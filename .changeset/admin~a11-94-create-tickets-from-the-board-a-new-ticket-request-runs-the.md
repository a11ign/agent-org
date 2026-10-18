---
"agent-org": minor
---

Ticket mode's board has a New ticket button on a machine that names `tickets.writer`: a person's request runs a short writer run of the ticket-writing skill, which leaves drafts for review. Each draft is shown editable on the board, with its duplicates linked above its buttons, and Approve, Approve and queue, or Discard. Only an approved draft creates a ticket, through the tracker with the instance's key, assigned to its user so it shows in Pick, with its project, goal, labels, priority, parent and relations. A machine that names no `tickets.writer` shows no New ticket button, and nothing changes for it. The writer's tracker access is read-only, and the routes work through remote connections and the tailnet-served board. A11-94.
