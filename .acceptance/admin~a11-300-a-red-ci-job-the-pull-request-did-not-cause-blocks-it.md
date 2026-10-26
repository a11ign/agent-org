The watch (`answerChecks` in `src/ticket-mode/pool-checks.ts`) reruns the failed jobs of a red required job once (`gh run rerun --failed`, the code host's `rerunFailedChecks`) before it asks a worker; a worker round starts only when the job is red again after the rerun. A job that is green on rerun is written to the flake log (`flakes.json` in the board's state, `src/ticket-mode/flakes.ts`) with the test or step that failed, the run and the head; a test that flakes three times in seven days is listed by `GET /api/flakes`, on the Runs page's pool bar, and as a `flaky tests` warning in `agent-org doctor`. A round that ends with no push and a worker's reply that says the failure is unrelated ends in one rerun of the failed jobs.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-checks-rerun.test.ts src/ticket-mode/pool-checks.test.ts src/ticket-mode/flakes.test.ts src/ticket-mode/server.test.ts src/ticket-mode/interventions.test.ts src/install/doctor.test.ts
pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/health-number.test.tsx
```

Consumer-declaration: none -- the queue file gains an optional `rerun` on a pull request's recorded check head, which an older reader ignores; `flakes.json` is a new file in the board's state; no option is added to a project declaration.
