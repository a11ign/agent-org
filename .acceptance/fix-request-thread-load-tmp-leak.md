`startThrowawayInstance`'s `stop()` (`scripts/loop-load.ts`) resolves only once the instance process has exited, killing it after ten seconds, and `request-thread-load.test.ts` awaits it, so the instance writes nothing into the test's TMPDIR after the test ends. The test passes with no `private-tmp` complaint.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/request-thread-load.test.ts
```

Consumer-declaration: none -- a test helper under `scripts/` and one test file; no non-test file under `src/` changes.
