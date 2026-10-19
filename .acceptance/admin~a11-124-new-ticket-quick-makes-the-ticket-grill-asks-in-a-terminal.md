New ticket has two modes and no review screen (A11-124). Quick runs unattended and the board creates the ticket when the run ends; Grill opens the run's terminal at once, the writer asks its questions there, a grill writer may end its turn while it waits, and the board creates the ticket when the grilling ends. The instruction in `tickets.writer.run` names no mode (the board passes `{mode}` or the brief does). The draft-review view and its Approve, Approve and queue and Discard buttons, and their routes, are gone. Duplicates are named in the new ticket's description. A run an older board left for review is failed, and creates nothing from its drafts.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/hook.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/writer-create.test.ts src/ticket-mode/writer.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/settings.test.ts src/install/doctor.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool.test.ts --testNamePattern "writer run|grill run|new-ticket run|ticket is created in each mode|a run making its tickets"
```

Consumer-declaration: none -- the writer is the board's own path. The doctor check is read by `agent-org doctor` only, and the remote proxy's writer actions are read by the page only; both are covered by the files above. `src/ticket-mode/board-view.test.ts` and the reviewer tests in `pool.test.ts` need a host declaration (`AGENT_ORG_HOST`), as CI sets it, so they are not in this block.
