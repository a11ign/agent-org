---
"agent-org": minor
---

Ticket mode's Pick view can list a team's or a project's open tickets, and a batch planner's `order.json` can no longer store a repository that is not one of the host file's `clones`.

- A11-69: a new host setting, `tickets.pick`: `"assigned"` (the default, the same request as before), `{ "team": "<key>" }` or `{ "project": "<name>" }`, which lists every open ticket of that team or project, whoever it is assigned to. Any other value refuses the board's start by name. An empty Pick view now says why and names the setting (`GET /api/pick`), and the count says whose tickets it lists.
- A11-70: the batch planner's brief names the `clones` keys as the only values `order.json`'s `repo` may take, besides `null`. When the board reads an `order.json` that places a ticket in any other repository, the ticket is given no planned repository and is handed to a person with the reason on its run; Retry works it without planning it again. The rest of the order, its blockers included, still stands.
