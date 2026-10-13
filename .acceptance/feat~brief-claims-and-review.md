A ticket-mode worker's brief has a fresh read-only review of the diff for changed behaviour, and a check that every claim in the pull request body has an assertion run on the base (`briefText` in `src/ticket-mode/worker-files.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- the brief's text changes; nothing a host file or the board reads does.
