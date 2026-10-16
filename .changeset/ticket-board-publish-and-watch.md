---
"agent-org": minor
---

Ticket mode watches the pull requests of a run Ready to merge and answers new feedback on its own, and a person can publish reviewed pull requests to a chosen channel from the board.

- A run Ready to merge, or Published, is watched every 3 minutes. A review that comments or requests changes, a conversation comment or an inline comment newer than the run's last round, from anyone but the account the workers use, queues a review round that resumes the same worker to answer it. So does a check that failed on the head commit since then. The board starts at most 3 such rounds. The next trigger hands the run to a person as Needs you. Merged or closed pull requests are never watched. The reads go through `src/ticket-port/pull-feedback.ts`.
- A new action, Respond to review, queues a review round straight away on a run Ready to merge, Published, or handed back after the 3 rounds. The worker is told a person asked it to answer the current feedback, and the count of automatic rounds starts again. Approve is now offered on drafts Awaiting review only.
- On a machine that sets `tickets.publish`, a run Ready to merge gets a Publish tick, and "Publish selected (N)" starts one publish run for every ticked run. It holds one slot, and it is the only run the hook lets use the `post-pr-to-slack` skill and the connectors `tickets.publish.connectors` names. When it writes `published` and `published.json`, each run shows Published with a link to the message. A publish run that fails, or takes over 30 minutes, leaves its runs Ready to merge, and the board says why.
- A review run is told to wait for checks in the foreground, with `gh pr checks <url> --watch --interval 30` and each Bash call under 10 minutes, never by ending its turn. One that waited in the background was parked as `no-outcome` mid-review (NBF-1463).
- A parked run whose worker writes a new outcome file after it parked is settled with that outcome once its agent is idle, as if it had been resumed and finished. Before, a worker that woke, wrote `reviewed` and went idle between two looks stayed `no-outcome`.
- A failed review round is retried as the same round, keeping what started it and its count of automatic rounds.
