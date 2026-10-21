Linear is the first agent-org plugin to run a concern: everything that talks to Linear (its GraphQL client and key reader, the doctor checks of its key and its MCP, the onboard steps that store the key and register the MCP, the tools a new-ticket run files with, its settings schema and its connector patterns) lives in `plugins/linear`, behind the tracker contract (now 1.1). Core reads the enabled tracker plugin from the registry, loads it once at start (`src/plugins/active.ts`: `ticket:serve` and `pr:open`), and imports no plugin's code and names no Linear endpoint or tool: `src/plugins/boundary.test.ts` refuses both, by file name. The plugin passes `runTrackerConformance` over a recorded `fetch`, `agent-org plugin disable linear` is refused while it is the only tracker, and the built-in `linear` row and its pin are gone. No host file changes: `provider: "linear"`, and a host with no tracker block, both resolve to the bundled package.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/linear src/plugins src/install/doctor.test.ts src/install/onboard.test.ts src/install/migrate-host.test.ts src/ticket-mode/hook.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/writer.test.ts src/ticket-mode/providers.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/settings-edit.test.ts src/ticket-mode/settings-view.test.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/readme-keys.test.ts src/ticket-mode/pr-open-ticket.test.ts src/ticket-mode/server.test.ts src/ticket-mode/serve-ticket-only-host.test.ts src/packaging/git-spawn-classification.test.ts
scratch=$(mktemp -d)
printf '%s\n' '{ "clones": { "app": "/tmp/app" }, "tickets": { "providers": { "tracker": { "provider": "linear" } } } }' > "$scratch/host.json"
export AGENT_ORG_HOST="$scratch/host.json"
node src/bin.ts plugin list | grep -qE '^  linear  *enabled  *contract 1\.1  *plugins/linear$'
! node src/bin.ts plugin disable linear 2>"$scratch/refused"
grep -q 'linear is the only tracker, and exactly one tracker must be enabled' "$scratch/refused"
! node src/bin.ts plugin uninstall linear 2>"$scratch/refused"
grep -q 'linear is the only tracker' "$scratch/refused"
! node src/bin.ts plugin install fake-tracker --replace 2>"$scratch/refused"
grep -q 'fake-tracker is an in-memory tracker for core.s tests' "$scratch/refused"
node src/bin.ts plugin config linear key | grep -q '^tickets.providers.tracker.key: not set$'
test -f plugins/linear/package.json && test ! -e src/ticket-mode/linear.ts
rm -rf "$scratch"
```

Consumer-declaration: none -- no existing host file changes meaning: `tickets.providers.tracker` keeps its shape (`provider: "linear"`, `enabled`, `key`, `connectors`, `workingState`, `plannedState`, `takenStates`), a host with no tracker block runs the same plugin, and the Settings page draws the same tracker rows. The new rows `agent-org doctor` shows (the plugin's own `tracker key` and `linear mcp`) keep the names they had. `src/ticket-mode/linear.ts` and `LINEAR_CONNECTORS` and `LINEAR_MCP_URL` of `src/install/onboard.ts` are not exports another repository reads.
