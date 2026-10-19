---
"agent-org": minor
---

A host can name commands that must pass before a ticket run starts: `tickets.preflight`, a list of `{ name, run, timeoutSeconds }`. While one fails, no ticket run starts and every queued one stays Queued, and the board shows a notice with the command's name and the first line it printed, so a worker is never started into a failure it cannot fix. A pass stands for a minute, a failure is tried again after a minute, and the pool never runs one command twice at once. Publishing and the new-ticket writer are not held. `agent-org doctor` runs each command and reports it, with its output. agent-org knows nothing about what a command checks. Without the setting, nothing changes: no command runs and no run is held.
