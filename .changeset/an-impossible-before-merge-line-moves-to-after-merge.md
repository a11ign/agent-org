---
"agent-org": minor
---

A Before-merge Done-when line that no branch can meet (it needs a published release, a person's own machine, or anything else a worker cannot reach) no longer blocks a pull request or reaches a person (A11-275). The planner names each such line in a `## Moved to After merge` plan section, with a reason (`release`, `machine` or `unreachable`) and who runs it. When the plan is attached, the board moves the line under the ticket's `### After merge` with who runs it, and records the move in a `## Decisions (the planner, <date>)` entry, before any worker starts. A plan that quotes a line the ticket does not hold under `### Before merge` is refused. The atomic reviewer treats such a line as After merge in every prompt, says so in its review, and does not block on it.
