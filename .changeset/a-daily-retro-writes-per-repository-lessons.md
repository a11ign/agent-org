---
"agent-org": minor
---

A daily ticket-mode retro writes each repository's lessons (A11-432, step 1 of 3), behind the new `tickets.lessons` setting, which is off by default. When it is on, the board reads the last 7 days of each repository's runs once a UTC day: reviewer findings, rounds started by red checks or a conflict, cap and stand-off events, and the reasons runs were handed to a person. It asks a model, with no tools, for the causes that recur in at least two runs, and writes `<stateDir>/tickets/lessons/<repo>.json`: at most 15 lessons, each naming the runs it came from. A lesson no retro finds again for 30 days is dropped. Worker and planner briefs do not include the lessons yet.
