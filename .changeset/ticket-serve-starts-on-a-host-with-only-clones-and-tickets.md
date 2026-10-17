---
"agent-org": patch
---

`ticket:serve` starts on a host file that holds only `clones` and `tickets`. It used to crash at import with a `ProjectDeclarationRefusal` stack for a missing `primary`, even with no reviewer configured. A host that sets `tickets.reviewer` with no `primary` now logs the named refusal once and starts without a reviewer. `ticket:remote-info` reads `~/.agent-org/host.json` when `AGENT_ORG_HOST` is unset or empty; a set variable naming an unreadable file is still refused by name (agent-org#1723).
