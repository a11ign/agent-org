---
"agent-org": minor
---

A run's card on the Runs page draws what its pushes cost in CI (`CI: 3 pushes, 48 jobs, ~184 min`) as a line of its own under the note, and the line turns amber (the existing warn tone) once the ticket is over its `tickets.ciBudgetMinutes` or the run is held at twice it (A11-261). Run detail still lists the line among the run's notes.
