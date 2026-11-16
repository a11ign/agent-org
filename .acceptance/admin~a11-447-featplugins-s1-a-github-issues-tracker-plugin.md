Step 2 of 2 of A11-447: core's Linear assumptions on the path of a GitHub Issues host, and an end-to-end run on a fixture whose tracker is GitHub Issues. The fault-injection fixture instance (`src/ticket-mode/fault-injection/fixture-instance.ts`) takes a tracker in place of the contract's fake: its host file names `github-issues`, the settings reader reads it back, and the plugin is built from the block core resolved. `plugins/github-issues/fixture-run.test.ts` queues a ticket read from the plugin, lets its scripted worker open a pull request and end `ready-pr`, lets GitHub merge it, and asserts the issue ends closed as completed by the board's own sweep; the same run on the contract's fake ends Done the same way. No test reaches GitHub.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github-issues/ src/ticket-mode/fault-injection/ src/ticket-mode/providers.test.ts src/install/migrate-host.test.ts src/plugins/health.test.ts src/ticket-mode/pick-scope.test.ts src/ticket-mode/assignee-filter.test.ts
```

Mutation: in `src/ticket-mode/providers.ts`, read `key` (and `tickets.linearKey`) whatever the tracker, and the A11-447 tests of `providers.test.ts` and `migrate-host.test.ts` fail; in `src/ticket-mode/pool-tracker.ts`, make `completeMerged` return at once, and `fixture-run.test.ts` fails with the issue still open.

Consumer-declaration: none -- no contract changes. For a host whose tracker is `github-issues`, `tickets.linearKey` is no longer read; a Linear host reads it as before.
