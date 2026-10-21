The Settings page has a Plugins section (its own call, `GET /api/plugins`; Enable, Disable, Install and Uninstall are `agent-org plugin`'s plans, `POST /api/plugins/action`; a secret is a copyable command and never a field), onboard installs and enables the plugins it chose and a profile names registry plugins, and doctor prints one section per plugin. A fresh machine's onboard enables the Linear and GitHub plugins, `agent-org plugin list` reads both from their blocks, and the board's `/api/plugins` shows them under Tracker and Code host.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install/onboard-demo.test.ts src/install/onboard.test.ts src/install/onboard-profile.test.ts src/install/doctor.test.ts src/plugins/health.test.ts src/plugins/registry.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/plugins-section.test.ts src/ticket-mode/remote-proxy.test.ts
```

Consumer-declaration: none -- no host file changes meaning. A host with no block keeps the defaults; onboard writes the `enabled: true` and the code host's block only where the host file does not hold them, and a profile saved before still reads.
