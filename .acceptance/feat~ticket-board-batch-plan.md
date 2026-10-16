The tickets one press of Queue plans first are one batch when `tickets.planner.run` names `{keys}`, at most 8 to a run (`enqueue`, `PLAN_BATCH_MAX`, `leaveBatch`, `batchPlanDone` in `src/ticket-mode/queue.ts`; `plansInBatches` in `settings.ts`; `planFirst` in `server.ts`). One planning run plans the batch from its own folder and holds one slot, and every ticket of it shows that run's workspace and pane (`nextStarts` in `queue.ts`; `placeOf`, `runMembers`, `startBatch`, `prepareBatch`, `watchRunning`, `watchParked`, `end`, `stop`, `close` and `reconcile` in `pool.ts`; `batchPlanBriefText` in `worker-files.ts`). On `planned`, each ticket's folder decides: its plan attached and the ticket queued again, or its `QUESTION.md` handed to a person (`attachBatch`, `planOneOfBatch` in `pool.ts`). The batch's `order.json` is checked and recorded in Linear as "blocks" relations, which the board then reads back as blockers (`parseOrder` in `batch-order.ts`; `recordOrder` in `pool.ts`; `addBlockers` in `source.ts` and `linear.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- a new optional placeholder in an existing host key; a planner instruction without `{keys}` plans every ticket alone, as before, and the only new tracker write is a "blocks" relation between tickets of one batch.
