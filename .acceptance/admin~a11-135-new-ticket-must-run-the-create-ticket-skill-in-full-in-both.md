New ticket's writer runs the create-ticket skill in full in both modes, files its own ticket and attaches its plan (A11-135). The brief no longer says "drafts only" and names one prohibition: no update, close or delete of an existing ticket. The writer's hook grants only the create and the two attachment tools, refuses any call with an `id` or `blocks`, refuses an attachment to a ticket the run did not create and an eleventh creation, and fails closed when its record of created tickets cannot be read. A PostToolUse hook records each created key. The board reads the outcome's keys, checks each against that record, reads each ticket back, checks the plan when `tickets.plan` is set, and shows each ticket as a link. A build worker is refused every filing tool by name, and the refusal names New ticket. Queues saved with drafts still load.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/hook.test.ts src/ticket-mode/writer.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/linear.test.ts src/ticket-mode/ui.test.ts src/install/doctor.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool.test.ts src/ticket-mode/server.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/serve-ticket-only-host.test.ts --testNamePattern "a new-ticket request runs the writer"
```

Consumer-declaration: none -- the writer is the board's own path. The plugin's create-ticket skill (its unattended create form) is a separate pull request in `a11ign/plugin`, which must be installed on the host before a live run.

---
