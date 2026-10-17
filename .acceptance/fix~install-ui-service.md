The ui service runs `ticket:ui`, the page's command since the instance and UI split, and the instance service still runs `ticket:serve` (`SERVICE_COMMANDS` in `src/install/service.ts`). `onboard` starts both services (`src/install/onboard.ts`). `doctor` checks that each service is registered and answers on its own port, `tickets.port` for the instance and `tickets.uiPort` for the ui (`serviceChecks` in `src/install/doctor.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install
```

Consumer-declaration: none -- the ui service had no command to run before this, and the instance service is unchanged.
