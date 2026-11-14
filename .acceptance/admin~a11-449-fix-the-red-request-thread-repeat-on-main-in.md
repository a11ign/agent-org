The throwaway `ticket:serve` that `scripts/loop-load.ts` starts for `request-thread-load.test.ts` is a process group of its own, and its `stop()` resolves only once every process of that group has exited (`stopGroup` in `src/lib/stop-child.ts`): the instance as before (SIGTERM, SIGKILL after the grace), then SIGKILL to what it left behind, waited for until the group is gone. Before, `stop()` waited for `bin.ts` alone, and the stand-in `gh` and `herdr` calls the instance had started outlived it by up to 5 minutes, re-parented, piling up across the 50 runs of `request-thread-repeat` (A11-449). A signal that ends the caller (SIGINT, SIGTERM, SIGHUP) is passed to the instance's group, so a Ctrl-C still stops it as it did when it shared the caller's group.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/lib/stop-child.test.ts src/ticket-mode/request-thread-load.test.ts
```

Mutation: in `startThrowawayInstance`, stop with `stopChild(instance, STOP_GRACE_MS)` again in place of `stopGroup`, and the A11-449 test of `request-thread-load.test.ts` fails with "the instance's process N outlived stop(), and writes to <dir>/state after it"; drop the `signalGroup(pgid, "SIGKILL")` line of `stopGroup`, and both A11-449 tests of `stop-child.test.ts` fail.

Consumer-declaration: none -- no host file key or contract changes. Only the test harness and its stop helper change; `stopChild` is unchanged.
