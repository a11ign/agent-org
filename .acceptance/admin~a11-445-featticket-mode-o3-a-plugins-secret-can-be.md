A plugin's secret can be entered on the board (A11-445, idea O3 of A11-429). A manifest secret marked `"enter": "token"` (the Linear key's `key.path` and `key.keychain`, Telegram's `tokenFile`) is a write-only password field on the Plugins page once the plugin is installed. `POST /api/plugins/secret` stores it where the plugin reads it: a mode-600 file directly in `~/.config/agent-org/` or the agent-org home, named `*.key`, `*.token` or `*-token` (written to a new file and renamed over, never through a symbolic link), or the macOS Keychain through `security -i` on standard input. When the setting named no place, the manifest's default place is used and the setting is pointed at it, checked against the page's base. The plugin's own checks run at once and the answer carries its rows. The value is in no answer, no refusal, no check row, no log line and no later read; a remote connection never receives it. A plugin with a secret the page can take now offers Install.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/secrets.test.ts src/ticket-mode/secret-route.test.ts src/ticket-mode/plugins-api.test.ts src/ticket-mode/remote-proxy.test.ts src/plugins/health.test.ts src/plugins/registry.test.ts
pnpm --dir ui exec rstest run --config rstest.config.ts --project components src/plugins/plugins-secret.test.tsx src/plugins/plugins-states.test.tsx
```

Mutation: drop `request.value.scrub` from `scrubbedRow` in `plugins-api.ts` and the A11-445 plugins-api test fails on the check row; drop the `SETTINGS_EDITS` entry for `/api/plugins/secret` and the remote-proxy test sends the secret over SSH; drop the `readJson` catch and the secret-route test sees JSON.parse quote the token.

Consumer-declaration: none -- no host file key changes meaning. A manifest's secret setting may carry an optional `enter: "token"`; a manifest without it reads as before. A save from the page may set the plugin's own existing key (`tickets.providers.tracker.key.path`, `key.keychain`, `messaging.tokenFile`) to the place it stored the secret.
