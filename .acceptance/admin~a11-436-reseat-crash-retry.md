When the board starts a run again because herdr restored its pane without the environment the board set (`src/ticket-mode/pool-reseat.ts`), it closes the old workspace first. If herdr then never answers the new `workspace create`, the run ends crashed with the board's own retry scheduled (`retryClosedRun` in `src/ticket-mode/pool-crash-retry.ts`, by the same `crashRetryAfter` rule a failed first start uses), and the board starts it again after the back-off with no person. If herdr refuses it for a reason that is not transient, the run stays crashed with no retry. This finishes the ticket's herdr criterion ("Given a herdr call that never answers … the run is not marked crashed") on the one herdr path #2064 left open.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-resume.test.ts src/ticket-mode/pool-crash-retry.test.ts src/ticket-mode/pool-crash-recovery.test.ts src/ticket-mode/pool-herdr.test.ts
```

Mutation: in `src/ticket-mode/pool-reseat.ts`, drop the `retryClosedRun` call after `end`, and the A11-436 reseat test in `pool-resume.test.ts` fails (`crashRetry` is undefined: the run waits for a person).

Consumer-declaration: none -- no host file key, route or payload changes.
