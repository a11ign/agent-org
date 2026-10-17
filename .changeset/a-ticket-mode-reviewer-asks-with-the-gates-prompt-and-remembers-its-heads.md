---
"agent-org": patch
---

Ticket mode's reviewer, behind `tickets.reviewer`, now gets the gate's own review prompt (`awaitingVerdictPrompt`) instead of a stub, and starts only for a settled-green head on a pull request that is not a draft. A machine with `drafts` on starts no reviewer. The once-per-head memory (the head each reviewer was started for, the reviewers started, and the verdicts a worker was asked to answer) is written under `stateDir` at `tickets/reviewers.json`, so a restarted pool starts no second reviewer on a reviewed head and asks no second round for an answered verdict. A memory file that cannot be read is said once in the log and remembers nothing. A reviewer's own review never moves `feedbackAt`. agent-org#1720.
