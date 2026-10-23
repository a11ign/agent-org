---
"agent-org": minor
---

Merged work completes its ticket without a person (A11-173). A review round's `done` on merged pull requests completes the ticket (with one still open it ends as the round's `reviewed` and completes on the merge), and a `done` drops the run's `partial`. A Completed run's card says `completed: <PRs> merged`. The After-merge lines of a merged run's ticket are posted once as a comment (tracker contract 1.4, the optional `comment`) and listed on the board under "After-merge checks" with who runs each, so such a run is Completed and never Needs you. A `Partial:` line with no step number, on a plan with more numbered steps, queues the next step: the board counts it from the run's record or the plan file, and says so on the card, in the log and in the next step's brief. The worker's brief says `partial` is build work a later run does, never an After-merge line, and that pull requests finishing a ticket together each say `Refs` with no `partial`.
