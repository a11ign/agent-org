`agent-org doctor` asks each service's port whether or not the service is registered, and tells a service started by hand apart from one that is not running (`serviceChecks` in `src/install/doctor.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install/doctor.test.ts
```

Consumer-declaration: none -- doctor's report only; no command, file or service changes.
