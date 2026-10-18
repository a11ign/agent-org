---
"agent-org": minor
---

Ticket mode: a worker whose ticket needs no code and whose Done-when items all hold ends its run with `{ "kind": "done", "reason": "...", "evidence": ["..."] }` (A11-91). The board moves the ticket to its team's completed state, posts the reason and the evidence on it, and shows the run Completed. A `done` with no reason or no evidence is `needs-human`, naming what it lacks, and so is one for a planning or review run, a ticket with open sub-issues, or a tracker that cannot complete it. `checked` is unchanged: the ticket stays open. The worker's brief says when to write `done` and when `checked`. A worker may also propose an edit to its ticket's title or description on `done`, `checked` or `needs-human`: the board shows the proposal beside the current text, and writes it only when a person clicks Apply edit, refused if the ticket changed since the worker read it. Discard drops it.
