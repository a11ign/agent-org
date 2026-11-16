`stopChild` (`src/lib/stop-child.ts`) is the one way a started child process is stopped: SIGTERM, SIGKILL after a grace period, resolved once it has exited. `startThrowawayInstance`'s `stop()` (`scripts/loop-load.ts`) and `ticket:capture`'s `realSpawn` both use it, and `request-thread-load.test.ts` awaits it, so the instance writes nothing into the test's TMPDIR after the test ends.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/request-thread-load.test.ts src/lib/stop-child.test.ts src/ticket-mode/capture-command.test.ts
```

Consumer-declaration: none -- `stopChild` is new and internal; `ticket:capture` stops its processes through it, with the same signals and grace, and now resolves once a killed process is gone.
