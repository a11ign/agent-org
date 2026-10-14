The ticket board pairs a browser once with a one-time code instead of a token in its URL: the key file (`src/ticket-mode/board-key.ts`), the codes (`src/ticket-mode/pairing.ts`), each browser's session (`src/ticket-mode/browser-sessions.ts`), the pairing page and `/pair` (`src/ticket-mode/pair.html`, `pairBrowser` and `pairedBy` in `src/ticket-mode/server.ts`) and `ticket:pair` (`src/ticket-mode/pair-command.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: the board's URL no longer carries a token, and its output no longer prints one. A script that read the token from the board's output reads `<stateDir>/tickets/board.key` instead, and sends it as `x-ticket-token` as before. Each browser pairs once with a code from `agent-org ticket:pair`. The browser cookie is now `ticket_session`, and the board accepts the key only in the header.
