---
"@a11ign/agent-org": minor
---

The ticket board reads a run as Completed once its pull requests have merged, as Linear's GitHub integration reports them, even while Linear still has its ticket in progress, which happens wherever a team's workflow does not complete a ticket on a merge. A run whose pull requests all closed unmerged reads as Cancelled. The In progress filter shows a still yellow dot, and only a working run's own icon spins. On Pick, a ticket sits under its parent whatever its own status, and a parent that is not yours, such as an epic someone else owns, heads its children without a checkbox; the board reads such parents through a new `GET /api/parents`.
