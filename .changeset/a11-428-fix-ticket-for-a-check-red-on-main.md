---
"agent-org": minor
---

A check that holds a ticket's pull request as red on main / not this run's, with no owner named by a `Blocked-by:` line or the check's refusal, now gets one fix ticket for each repository and check (A11-428). The board's dependency sweep asks the ticket writer for it, with the check's error lines quoted as data, and queues the one ticket the run made on the saved choice. A run that made no ticket is asked again later. Every held pull request's card names the fix ("… is red on main / not this run's; owned by A11-600"). When the fix's pull request merges, the board brings each held pull request up to date with main, so its checks run again with the fix in them. This works in repositories that run no CI on main. The new host setting `tickets.fixRedMain` (default true) turns this off and keeps the hold as it was.
