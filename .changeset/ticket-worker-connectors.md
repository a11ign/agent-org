---
"agent-org": minor
---

A ticket-mode worker can call the connector tools the host file names in the new `tickets.connectors`, as regular expressions anchored at the tool's name with `^mcp__`, such as `["^mcp__claude_ai_Linear__(get|list|search|extract)_"]` for Linear's reads. Its brief names them, so it can read its ticket's parent, its blockers and related work in the tracker. Every other connector stays refused, a write to the same connector included, and a machine that names none refuses every connector, as before.
