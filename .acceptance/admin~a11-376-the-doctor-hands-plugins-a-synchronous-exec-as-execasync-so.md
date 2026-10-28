The doctor hands the plugins its own `execAsync`, `realExecAsync` in its real deps, instead of the synchronous `exec` wrapped in a promise. A plugin's health check that the board runs on its own thread no longer holds the board's event loop while a `gh` call runs. On v0.331.0 that wrapper was 84 of 144 "held the loop" lines in 24 minutes (A11-376).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install/doctor.test.ts
```

Consumer-declaration: none -- no host file key changes meaning.
