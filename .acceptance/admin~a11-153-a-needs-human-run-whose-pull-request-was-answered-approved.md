A finished run settles from its own pull requests whatever its outcome was. When they have all merged it is Completed and the board moves its ticket to done (unless the run is declared partial); when they all closed unmerged it is Cancelled. A `needs-human` run whose pull request has a head other than the one the run ended at, or is approved at its head by a reviewer other than the workers' account, reads Awaiting review with "Answered: awaiting review" or "Approved" on its card, and the question it asked sits under "The question it asked". A conflict a stacked run records with its blocker's branch clears once its pull requests are mergeable, and a card never says the same note twice.

Acceptance:
```bash
set -e
npm run typecheck
npm run lint
: "${AGENT_ORG_HOST:?set it to a host declaration, such as the fixture's .agent-org/host.json}"
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-port/pull-feedback.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/stack-rebase.test.ts src/ticket-mode/ui.test.ts
```

Consumer-declaration: none -- ticket-mode internals: the board's run status, the pool and the queue, which no other package imports.
