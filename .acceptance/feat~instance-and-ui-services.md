Ticket mode is split into an instance and a page that connects to many instances: the instance serves only its key-holding API (`src/ticket-mode/server.ts`), `agent-org ticket:ui` serves the page, pairs browsers and passes their calls on to a connection's instance with its key and Host (`src/ticket-mode/ui-server.ts`, `remote-proxy.ts`), `connections.json` is read and refused strictly, with plain http to another host refused, the key file held to mode 600 and `profiles.json` read in its place (`src/ticket-mode/connections.ts`), and the header's switcher reads every view, action and terminal link from the chosen connection (`src/ticket-mode/ui.html`, `board-view.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- a machine with no connections file shows its own instance through `ticket:ui`, and scripts call `ticket:serve` with its key as before.
