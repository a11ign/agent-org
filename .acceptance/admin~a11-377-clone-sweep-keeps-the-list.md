The clone sweep keeps the organisation's list for `ORGANISATION_SWEEP_MS` (15 minutes) and reads it again once it is that old. A list that could not be read is not kept. A plan's brief and a worker's `wrong-repo` read it fresh, as before (A11-377).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-org-repos.test.ts
```

Consumer-declaration: none -- no host file key changes meaning.
