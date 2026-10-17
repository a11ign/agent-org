The ticket board switches between this machine's board and other machines' boards over SSH: `profiles.json` is read and refused strictly (`src/ticket-mode/profiles.ts`), the tunnel and key read run through an injected process runner (`src/ticket-mode/remote.ts`), the page's calls are passed through it on an allowlist of routes (`src/ticket-mode/remote-proxy.ts`), `agent-org ticket:remote-info` prints a board's port, key and terminal to a pipe only (`src/ticket-mode/remote-info-command.ts`), `/api/profiles` and `/p/<profile>/api/...` are served to a paired browser only (`src/ticket-mode/server.ts`), and the header's switcher reads every view from the chosen board (`src/ticket-mode/ui.html`, `board-view.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- a machine with no profiles file shows no switcher and runs no ssh, as before.
