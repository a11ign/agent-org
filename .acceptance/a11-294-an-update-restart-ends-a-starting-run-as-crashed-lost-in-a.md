A restart of the board (`reconcile` in the pool) puts a run that was `starting`, or `running` with no herdr workspace on record, and that herdr does not list, back on the queue with the same round (`review`, `feedback`, `asked`) instead of ending it `crashed` ("lost in a restart"), and the run starts again on the next pass. A run that had an agent open is still lost and queued again once. `agent-org update` waits for no run to be `starting` before it restarts the instance, for at most two minutes (polled every five seconds), restarting anyway when the cap is reached.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-readopt.test.ts src/install/update.test.ts
```

Consumer-declaration: none -- no host file, queue file or setting changes meaning. The run log gains a `requeued` event with the reason `restart`, which the run timeline in the UI words as "a restart before its agent opened".
