`checkedForQueue` in `src/ticket-mode/server.ts`, which `POST /api/queue` and a writer run's queueing both use, replaces each parent ticket with its open sub-issues (in `childOrder`'s order, recursively for a sub-issue that is itself a parent, each key once), so a batch that names a parent queues its children and the rest of the batch instead of being refused. A parent is never queued itself.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/server.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts
```

Mutation: in `checkedForQueue`, push the ticket even when it has children instead of adding its sub-issues, and the A11-429 test fails with enqueue's "a parent is not queued" refusal.

Consumer-declaration: none -- no host file key or contract changes. `POST /api/queue` answers 200 where it answered 400 for a batch naming a parent; the page's own Queue its children route is unchanged.
