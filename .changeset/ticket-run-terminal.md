---
"@a11ign/agent-org": minor
---

A ticket-mode run that ends `needs-human`, `wrong-repo` or with no outcome is parked rather than closed: its herdr workspace stays open and holds no slot, so a person can answer the agent. When the agent works again the run is live again, its old outcome is moved to `outcome.prev.json`, and the worker writes a new one. The board's new Close action shuts a parked run's workspace and keeps its outcome. The host file's optional `tickets.terminal`, a web address with `{workspace}`, `{pane}` and `{key}`, gives each live or parked run an Open terminal link, such as herdr web ui's terminal for that pane.
