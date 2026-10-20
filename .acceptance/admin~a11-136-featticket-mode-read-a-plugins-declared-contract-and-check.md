A plugin's declared agent-org contract is read from its install and checked against the host's keys (A11-136). `readPluginContract` reads `metadata.agentOrg` of the plugin's `.claude-plugin/plugin.json` and reports no contract, a contract, or one that is present and malformed with the field named. `contractRows` returns one row per mismatch: contract major, agent-org range, connector need, command need, skill the plugin does not provide, plugin not enabled, plan-file pattern. `pluginProblems` gives the Settings page and `clearRunDir` the same answer, and a run start is refused with each row's sentence. A plugin with no contract, and one whose contract matches, starts as before.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/plugin-contract.test.ts src/ticket-mode/plugins.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/settings-read.test.ts src/ticket-mode/settings-view.test.ts
npm run typecheck
npm run lint
```

Consumer-declaration: none -- no plugin declares `metadata.agentOrg` yet (A11-137 adds the a11ign plugin's declaration), so on every machine today the check finds no contract and returns no row. The Settings page receives the rows in its view and does not draw them (A11-138).
