---
"@a11ign/agent-org": patch
---

A decision run can now serve the `unclaimed-blocker-cleared` cause: one row whose blocker closed is promoted to `ready` or held with a stated reason, by a one-shot Haiku run (Sonnet when the provider says so). Nothing changes for a project until its `.agent-org/seats.json` sets the cause to `run`, and deleting that line is the revert. A promotion is written only when the order names the head the run re-read the row's Open-check at and every edge is closed; the default is `hold`.
