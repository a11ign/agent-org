---
"@a11ign/agent-org": minor
---

Ticket mode reads two optional host-file keys. `tickets.brief` names a markdown file that joins every worker's brief under "On this machine", so a machine can say how its workers share it, such as which command starts a dev server without taking a fixed port. `tickets.deny` lists Bash commands the PreToolUse hook refuses as well as its own, each a regular expression with the reason the worker is told. A host that declares neither is unchanged.
