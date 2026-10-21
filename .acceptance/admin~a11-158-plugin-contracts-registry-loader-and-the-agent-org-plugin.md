Every external concern of ticket mode is an agent-org plugin behind a versioned contract (`src/plugins/contracts/`: tracker, code host, publisher, reviewer, exposure, messaging), found by a registry (`src/plugins/registry.ts`: bundled `plugins/*` packages, today's providers as built-ins, and one fake per concern) and loaded only when enabled (`src/plugins/loader.ts`). `agent-org plugin list|install|enable|disable|uninstall|config` writes `tickets.providers.<concern>` through the Settings page's own path, and `enabled` is new in a block. Disabling the only tracker or code host is refused by name; disabling the publisher works and the board publishes nothing; a plugin of an unsupported contract major is refused at start and in doctor; each fake passes its concern's contract suite. No integration moves, and no host file changes.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/plugins src/install/doctor.test.ts src/ticket-mode/providers.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/settings-edit.test.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/readme-keys.test.ts src/packaging/bin-commands.test.ts
scratch=$(mktemp -d)
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "providers": { "tracker": { "provider": "linear" }, "publish": { "provider": "slack", "run": "post {prs} into {dir}" } } } }' > "$scratch/host.json"
export AGENT_ORG_HOST="$scratch/host.json"
node src/bin.ts plugin list | grep -cE '^(tracker|code host|publisher|reviewer|exposure|messaging):' | grep -qx 6
node src/bin.ts plugin list | grep -q '^  fake-tracker  *available'
! node src/bin.ts plugin disable linear 2>"$scratch/refused"
grep -q 'linear is the only tracker, and exactly one tracker must be enabled' "$scratch/refused"
node src/bin.ts plugin disable slack
node src/bin.ts doctor | grep -q 'publisher (slack, disabled): disabled: publishes nothing'
node src/bin.ts plugin enable slack
node src/bin.ts doctor | grep -q 'publisher (slack): from tickets.providers.publish'
rm -rf "$scratch"
```

Consumer-declaration: none -- no existing host file changes meaning: `enabled` is absent in every live host file and absent is true, a block names the same providers it did, and the built-ins are the code core already runs. The new `agent-org plugin` command and the new rows of `agent-org doctor` are additions.
