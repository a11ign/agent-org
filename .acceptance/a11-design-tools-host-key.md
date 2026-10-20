`tickets.designTools` (true or false, absent is false, any other value refused by name) decides step 7 of a worker's brief: false has it decline a design gate's check as "unattended worker, no design tool access", and true has it do the check and decline only when a design call is refused. The key has a Settings row, and the plugins record names it as a machine fact that stays in `host.json`.

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/settings.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/readme-keys.test.ts
```

Mutation: the choice between the two step 7 texts was made to always take the decline text, and then `prepare` was made not to pass `designTools` on; each time at least one new test went red (the two step 7 texts, and the brief a pool writes). Both were restored and the suites passed again.

Consumer-declaration: none -- `designTools` defaults to false, so a machine whose host file does not name it has the brief it had, and only `briefText` and the settings readers use it.
