`GET /api/plugins` answers from the plugins' last checks at once (`checkedAt`, `checking`) and runs them again behind the page, each plugin's checks in a child process of its own with a 10 s limit; the Plugins page shows their age and reads again while they run (A11-270, step 1 of 4).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/plugins/health-read.test.ts src/plugins/check-child.test.ts src/ticket-mode/plugins-api.test.ts src/install/doctor.test.ts src/ticket-mode/server.test.ts
pnpm --dir ui exec rstest run --config rstest.config.ts src/plugins/
```

Consumer-declaration: none -- `/api/plugins` gains two fields and an optional `?check` query; an older page ignores them, and a newer page against an older instance draws no age line.
