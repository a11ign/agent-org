---
"agent-org": patch
---

The orchestrator's one-shot lane is handed the row readers the tick reads with, as the ceo's lane already was (`withOneShotLanes` in `src/wake.ts`). With `workers.orchestratorOneShot` ON, a plain ready `lane:orchestrator` row is converted to a one-shot run again, and a `fleet-gated` row or one whose Acceptance names a fleet or lab command keeps the gate's `orchestrator` order. Since #1527 the lane had been inert: with no reader handed, it converted no row. The flag OFF path is unchanged.
