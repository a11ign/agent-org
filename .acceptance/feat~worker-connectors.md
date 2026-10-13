A ticket-mode worker may call the connector tools the host file's `tickets.connectors` names (`connectorPatterns` in `src/ticket-mode/settings.ts`, `toolVerdict` and `machineConnectors` in `hook.ts`, `CONNECTORS_FILE` and `briefText` in `worker-files.ts`, `prepare` in `pool.ts`), and every other connector stays refused.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- a host file without `tickets.connectors` refuses every connector, as before.
