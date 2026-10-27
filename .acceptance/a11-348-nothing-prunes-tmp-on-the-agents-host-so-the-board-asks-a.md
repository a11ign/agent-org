The `/tmp` janitor (`a11ign-tmp-prune.timer`, every minute) now removes any entry directly under `/tmp` that the agent user owns, that nothing has written for over 24 hours (the newest write in its top two levels) and that no running process holds (open file, working directory, argv, environment, or a bound unix socket), in the same small niced batches as before. `claude-<uid>` (session scratchpads), mount points, the review leftovers of open pull requests and entries of other users are left alone. The board's "/tmp holds N entries" note names `a11ign-tmp-prune.timer` and the journal command that shows its count, and clears at under 1,000.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/prune-tmp-janitor.test.ts src/packaging/prune-tmp.test.ts src/ticket-mode/host-alerts.test.ts src/packaging/host-units.test.ts
```

Consumer-declaration: none -- no host file changes meaning. The installed unit's `ExecStart` argument changes from `--fixtures-only` to `--timer`; `host:install` rewrites the unit from the shipped template.
