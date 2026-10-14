---
"agent-org": patch
---

The ticket board no longer starts a worker that would run without the plugins `tickets.plugins` names. A worker starts in its ticket's own folder, which Claude Code treats as a project of its own, so a plugin installed only for another project was never loaded there, though the worker's settings enabled it and `claude plugin list` in that folder reported it enabled. The board reads Claude Code's install record before each run. A plugin installed only for another folder, not installed, or missing from the plugin cache ends the run before it starts, with the command that installs it for every folder. An unreadable record refuses nothing. Both briefs now tell a worker to stop for a person when a skill they name is missing, rather than follow a copy of its files.
