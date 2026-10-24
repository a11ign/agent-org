## What it is

Step 2 of 2 of the Atomaut Plugins page: `/next/settings/plugins` is the page the eight Plugins boards draw, in place of the shell's placeholder. Integrations are one card for each concern (its checks with each fix and a Copy button, the commands that set its secrets, the "Active plugin" choice where a concern has more than one plugin, its own settings edited through the Settings flow, and Disable, Enable, Install and Uninstall as the plan allows, off with the plan's sentence where it refuses). Uninstall and a replacing install ask first, in the backend's own sentence. The outcome is the Applied, Refused or file-changed banner, and an instance that cannot be reached is the Health unknown board. The Claude plugins tab lists `tickets.plugins`, with each plugin's health, skills and needs, and adds, removes and changes a skill through the Settings preview and save, asking first for a dangerous key. No `src/` file changes.

## Acceptance

`ui/src/plugins/plugins-actions.test.tsx` holds each action (install, enable, disable, uninstall), both confirmations (Cancel and Escape post nothing; the yes posts `confirmed: true`), Applied with the in-force sentence and the backup, Refused with the server's sentence and the file-changed banner with its re-read. `plugins-states.test.tsx` holds loading, the failed read, health unknown, the badge count, a remote instance and a refused host file. `plugins-claude.test.tsx` holds the Claude tab, add, remove and the skill selects through the preview and save. `plugins-model.test.ts` holds the words of each status, and `ui/test/plugins/conflict.test.ts` holds the conflict sentence the page keeps to the one `runAction` throws. `ui/test/plugins/plugins.page.test.ts` drives Chromium over the build: the eight boards' states and the Claude tab at 1440px and 390px with no horizontal overflow (captures in `ui/captures/plugins/`).

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
npx eslint ui --quiet
ls ui/captures/plugins/plugins-ready-1440x900.png ui/captures/plugins/plugins-conflict-390x844.png ui/captures/plugins/plugins-claude-390x844.png'
```

Consumer-declaration: none -- `ui/` is a private package nothing else reads; no option is added to a project declaration.
