---
"agent-org": minor
---

A plan names who runs each After-merge check, and the board closes the checks it can see by itself (A11-277, step 2 of 3). The planner brief asks for a `## After-merge checks` section: one bullet per After-merge line, with `Runner: session | person | board`, an `Escalation:` item for a `person` check, an `Observe:` spec for a `board` check, and one line of `Evidence:`. The board refuses to attach a plan that leaves out an After-merge line naming nobody to run it, or names a runner, escalation item or spec it cannot record. When a line becomes a check, it takes the plan's runner, and the board passes a `board` check by itself, with its evidence posted on the ticket, when the dependency sweep files a ticket (`sweep-ticket`), a review lands on a named pull request (`review`), a run's pull request in a repository merges with no person (`queue-merge`), or the board wakes a worker on its declared wait (`wake`).
