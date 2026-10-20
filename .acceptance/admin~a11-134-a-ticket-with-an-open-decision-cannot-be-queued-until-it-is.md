A ticket whose Acceptance, Done-when or Open-check still leaves a decision open cannot be queued. Pick shows "Needs a decision" with the open line as its title and disables the ticket's Select, and Grill starts the grill on it in a terminal. Its answers are written into the ticket, and then it can be queued. A screen ticket also needs its behaviour grilled first. A worker never starts on a ticket with an open decision: it ends needs-human with the one question. The planner's check refuses a plan that records a product decision as made without asking (A11-134).

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/open-decisions.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/writer.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/server.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/remote-proxy.test.ts
```

Mutation: each guard was broken in turn, and the one test that names it went red, then the file was restored: the queue's `refuseDecisions` (queue.test.ts, 1 of 79 red), the start guard in `openDecisionHold`, which reads the tracker's current ticket (pool.test.ts, 1 of 246 red when it is reverted to the queued copy), the plan's product-bullet refusal (pool.test.ts, 1 of 245 red), and the Grill's unchanged-text check (pool.test.ts, 1 of 245 red).

Consumer-declaration: none -- the decision check is read by Pick, the queue, the start guard and the planner's plan check, all of which are changed here. The page reads only the `needsDecision` field the server adds, so no other consumer reads a changed shape.
