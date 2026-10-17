Ticket mode never queues a parent (A11-76). The Linear read of the Pick list carries each ticket's open sub-issues (`children`, filtered to states not completed, canceled or duplicate) in the same request, mapped to `Ticket.children` in `src/ticket-mode/source.ts` by `src/ticket-mode/linear.ts`. `enqueue` in `src/ticket-mode/queue.ts` refuses a parent through `refuseParents`, so `POST /api/queue` answers 400 with the reason. `POST /api/queue-children` in `src/ticket-mode/server.ts` queues a parent's open sub-issues in the order `childOrder` gives from the tracker's blockers, or in identifier order with a note, and `src/ticket-mode/remote-proxy.ts` passes it on. The Pick view (`src/ticket-mode/ui.html`, with `isParentTicket` and `selectable` in `src/ticket-mode/board-view.ts`) marks a parent, counts its sub-issues, gives it no checkbox and offers Queue its children.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/linear.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/server.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/board-view.test.ts
```

Consumer-declaration: none -- `Ticket.children` is optional, so a source that does not read sub-issues leaves every ticket ordinary; the new route is additive, and the only behaviour a caller of the instance sees change is that `/api/queue` now refuses a ticket with open sub-issues.
