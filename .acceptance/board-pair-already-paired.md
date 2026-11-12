The board's session cookie is `SameSite=Lax`, and `POST /pair` from a browser that already holds a live session answers `200 {"paired":true}` with no new cookie and without spending the live code, instead of `404 no route POST /pair`.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ui-server.test.ts
```

Mutation: remove the paired `POST /pair` branch from `handle` in `src/ticket-mode/ui-server.ts`, and the "already paired and presses Pair again" test fails with 404.

Consumer-declaration: none -- no host file key or contract changes. One cookie attribute and one answer of the board's own pairing route.
