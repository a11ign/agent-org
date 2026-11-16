The settle states join the pure state machine `src/ticket-mode/pr-state-machine.ts` (A11-437, step 3 of 3). `settleStep` decides what a review round's `done` does with its ticket from the states of the run's pull requests (A11-173): complete it when every one merged or closed and one merged; ask a person when every one closed unmerged; or wait, naming each pull request still open or unread. `reviewAtHead`, the read of a head's review for readiness (A11-179) that the cancelled gate turns on (A11-342), moves there too, and `pool-settle.ts` re-exports it, so its importers are unchanged. `pool-settle.ts` now only acts on the step.

Random event sequences (red, cancelled, rerun, ejected, push, approval, an unread state, merged, closed) over runs of one to three pull requests show that the run settles exactly as its pull requests say, that every wait names the pull requests it waits on, and that merged, closed and needs-a-person are reachable from every start state that allows them. The behaviour tests of the review round's `done` in `pool.test.ts` (A11-173) pass unchanged.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pr-state-machine-settle.test.ts src/ticket-mode/pr-state-machine.test.ts src/ticket-mode/pr-state-machine-queue.test.ts src/ticket-mode/pool-cancelled-gate.test.ts
```

Mutation: in `settleStep`, return `{ do: "complete" }` when `settled === "cancelled"`, and the property test fails at `seed 1, event 2 (closed): settled complete`. Return a wait without the open pull requests in its reason, and it fails at `seed 1, event 0 (unread): the wait does not name …/pull/1`.

Consumer-declaration: none -- no host file key, config key or contract changes, and no stored record changes shape.
