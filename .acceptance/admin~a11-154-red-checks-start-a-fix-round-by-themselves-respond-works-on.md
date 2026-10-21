A red check on a pull request the board holds, at its current head, starts one fix round for its run by itself, with the failing checks and their log lines in the round's brief: for a run Ready to merge, one that ended needs-human, with no outcome or crashed, and one parked on a question (its workspace is closed first). The round cap applies, and past it any such run reads Needs you. A check that failed for an infrastructure reason is rerun once for the head and named on the card, and red again it is named for a person; no worker is handed it. Respond to review works on any finished run with a pull request open, whatever its outcome, and a press that cannot act says why. A blocker lets go once its pull requests have merged, whatever its ticket's state says. A round never starts beside a Talk session that holds the run's session (it waits, or closes an idle leftover first and says so), and a Talk is refused while a round is queued or running.

Acceptance:
```bash
set -e
npm run typecheck
npm run lint
: "${AGENT_ORG_HOST:?set it to a host declaration, such as the fixture's .agent-org/host.json}"
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-port/pull-feedback.test.ts src/ticket-mode/pool-checks.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/reviewer-port.test.ts src/ci-failure-class.test.ts src/ci-rerun-on-5xx.test.ts
```

Consumer-declaration: none -- ticket-mode internals (the board's run status, the pool and the queue) and the log readers moved to a leaf, `src/ci-log-lines.ts`, which `src/ci-failure-class.ts` re-exports unchanged; no other package imports them.
