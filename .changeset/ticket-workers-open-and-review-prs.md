---
"agent-org": minor
---

Ticket-mode workers can open their pull requests, and any org pull request can be given the atomic review on demand. The host's `gh` wrapper no longer sends a worker that has `AGENT_ORG_TICKET` set to `pr:open`, which needs a GitHub row and a gate claim that ticket mode does not have (A11-75). The worker's own ticket hook decides which `gh pr create` it may run. The new `agent-org ticket:review <pull request url> [--head <sha>]` starts the same atomic reviewer the pool starts, in the tickets' herdr session, for a pull request the pool does not know: one a person opened for a run that ended `needs-human`, or one the chairman's session wrote. It makes every refusal the reviewer port makes.
