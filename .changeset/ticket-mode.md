---
"@a11ign/agent-org": minor
---

Ticket mode: `agent-org ticket:serve` starts a local board where you pick your assigned Linear tickets, queue each to one or more repositories with a model and effort, and a pool of Claude workers (one herdr workspace per ticket, in its own session) turns each into draft pull requests or an outcome saying why not. `ticket:hook` holds each worker to a draft and an outcome file. Configuration is the host file's `clones` and an optional `tickets` block, which no existing reader reads, so a host that declares neither is unchanged. The README gains a "Ticket mode" section.
