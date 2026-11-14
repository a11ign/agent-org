The rules for a pull request's red checks (A11-154, A11-300) and for the cancelled runs that block an approved, armed one (A11-342, A11-403) are one pure state machine, `src/ticket-mode/pr-state-machine.ts` (A11-437, step 1 of 3): `checkStep` and `cancelledStep` say what the board does next (wait and why, read, rerun, start a round, name a person, stop), and `pool-checks.ts` and `pool-cancelled-gate.ts` only make the reads, reruns and writes a step names. Random event sequences (red, red for the infrastructure, cancelled, a rerun finishing, ejected, a new push, approval, a worker's reply, a refusal, time passing, merged, closed) fed to the machine show that one check is rerun at most `RED_RERUNS_PER_HEAD` times at one head and the cancelled runs at most `MAX_CANCELLED_RERUNS` times, that every state that waits shows a reason, and that merged, closed and needs-a-person are reachable from every start state. The behaviour tests of both modules pass unchanged.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pr-state-machine.test.ts src/ticket-mode/pool-checks-reply-clock.test.ts src/ticket-mode/pool-checks.test.ts src/ticket-mode/pool-checks-rerun.test.ts src/ticket-mode/pool-cancelled-gate.test.ts
```

Mutation: in `onInfrastructure` of `pr-state-machine.ts`, make `reranForIt` never true (an infrastructure failure red again after its rerun is rerun again instead of named), and the property test fails: `seed 48, event 21 (busy): the red check was rerun more than 3 times at one head`.

Consumer-declaration: none -- no host file key, config key or contract changes, and no stored record changes shape.
