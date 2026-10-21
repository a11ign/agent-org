A merged `Partial` pull request of a plan step now queues the ticket's next step by itself, and a ticket is taken by another instance only when another instance's claim says so (A11-168). The board reads the step from the run's `partial` declaration (`step <N> of <M>`), records each merged step and its pull requests on the run (`steps`), and replaces the finished run with a queued one for step N + 1, whose card says `step 1 of 9 merged; step 2 queued` and whose brief lists the steps merged. A merged `Partial` run that names no step, the last step, or a step not past the last merged reads Needs you with the reason, not Completed. The tracker contract is 1.2 (`claim`, `claims`); the Linear plugin writes the claim as a comment when a run starts, `takenState` needs another instance's claim, and the queue routes read the ticket and its claim again before they refuse, answering 503 when the tracker cannot be asked.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/plan-steps.test.ts src/ticket-mode/pick-taken.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/server.test.ts src/plugins plugins/linear
npx tsc --noEmit -p tsconfig.json
test -f src/ticket-mode/board-view/plan-steps.ts && test -f src/ticket-mode/queue/queue-next-step.ts
grep -q 'TRACKER_CONTRACT_VERSION = "1.2"' src/plugins/contracts/tracker.ts
```

Consumer-declaration: none -- no host file changes meaning. `tickets.providers.tracker.takenStates` keeps its shape and its default; it now names the states in which another instance's claim holds a ticket. A ticket In Progress with no claim (moved by hand, or by an instance from before claims) is no longer taken: the README says so.
