---
"agent-org": patch
---

A `lane:orchestrator` row labelled `fleet-gated`, or whose Acceptance names a fleet or lab command, is no longer turned into a one-shot run when `workers.orchestratorOneShot` is on (a11ign/agent-org#1527). Its order keeps the gate's session, the standing `orchestrator`, as it does with the flag off: a spawned seat has no inventory and no control host, so it cannot reach the plane and only ends on the stop hook's bound. A row whose body cannot be read keeps the gate's order too. `withOrchestratorOneShot` takes the `rowOf` and `readRow` readers for this, and with neither handed it converts no row.
