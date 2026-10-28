The After-merge sweep runs `diagnose` in a child of the board's own Node with `execAsync`, bounded at five minutes. It reads the lines the child prints as JSON on its last line. A child that fails, times out or prints no lines is logged with its reason, and the sweep reads no doctor, as before. The doctor's synchronous spawns now hold only the child, never the board's loop (A11-377).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/after-merge/host-doctor.test.ts src/ticket-mode/after-merge/sweep.test.ts
```

Consumer-declaration: none -- no host file key changes meaning.
