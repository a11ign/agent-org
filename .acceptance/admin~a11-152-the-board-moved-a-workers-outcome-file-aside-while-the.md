The board never moves a build worker's outcome file aside. Answering a parked run or talking to a finished one writes a stale mark (`outcome-stale-before`) beside the outcome, and the Stop hook reads the outcome once and judges one written at or before the mark as no outcome. The only move left is a Grill run's question, which waits while `stop-active` is fresh. A worker that writes its outcome and stops, with the board's watcher running, is not told to write it again.

Acceptance:
```bash
set -e
npm run typecheck
npm run lint
: "${AGENT_ORG_HOST:?set it to a host declaration, such as the fixture's .agent-org/host.json}"
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/hook.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/outcome.test.ts
```

Consumer-declaration: none -- ticket-mode internals: the Stop hook, the pool and the outcome contract, which no other package imports.
