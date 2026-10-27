The board keeps rolling health figures and serves them at `GET /api/health`; a watchdog outside the board's loop (the `watchdog` service, `agent-org ticket:watchdog`) restarts the instance for startable runs with free slots and no start for 10 minutes, no completed `fill()` pass for 5 minutes, or no answer from `/api/health` for 30 s; it logs and counts each restart, asks for one defect ticket per hour with more than 2 restarts, and a restart keeps running runs running. Doctor and the board's sidebar show the figures and flag a loop p99 over 100 ms, call failures over 1%, and any watchdog restart in the last day (A11-363).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/watchdog.test.ts src/ticket-mode/watchdog-defect.test.ts src/ticket-mode/pool-figures.test.ts src/ticket-mode/pool-readopt.test.ts src/ticket-mode/loop-delay.test.ts src/ticket-mode/health-route.test.ts src/ticket-mode/health-flags.test.ts src/ticket-mode/call-outcomes.test.ts src/ticket-mode/rolling-count.test.ts src/ticket-mode/shutdown-wait.test.ts src/install/service.test.ts src/install/update.test.ts src/install/doctor.test.ts
```

Consumer-declaration: none -- no host file key changes meaning. A machine that runs the instance service gets the `watchdog` service registered by its next `agent-org update`; `agent-org stop watchdog` turns it off and the update leaves it off.
