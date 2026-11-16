---
"agent-org": patch
---

The Copilot coding agent (`app/copilot-swe-agent`) is a declared identity, so the tickets' reviewer reviews its pull requests like a worker's. It refused them as outside the org, and the member who assigned Copilot the work may not approve them on GitHub, so they could never merge (a11ign/agent-org#2023). A fork is still read as a stranger's.
