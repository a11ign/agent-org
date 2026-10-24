## What it is

Step 1 of 2 of the Atomaut Plugins page: the read and the badge, not the page yet. `GET /api/plugins` gains `claude` (the Claude Code plugins `tickets.plugins` lists, read from the host file as it is now) and `attention` (the number of plugins that need attention, one each: an agent-org plugin that failed or has a failing check, a package the registry refused, a Claude plugin that does not load, whose health is unknown, or that has a contract row). The answer to a plugin action gains `backup`, the file the save kept. In `ui/src/plugins/`, the Settings sub-nav's Plugins link shows "1 needs attention" ("N need attention") only when the one read of `/api/plugins` counts more than zero, on every Settings page. The Plugins page itself is still the shell's placeholder.

## Acceptance

`src/plugins/attention.test.ts` counts each kind once and leaves a whole, disabled or uninstalled plugin out; `src/ticket-mode/plugins-api.test.ts` holds `claude` and `attention` over a seam that runs no program; `src/plugins/page-actions.test.ts` holds `backup`, the conflict sentence for a stale `base` with nothing written, and the refusal of an unconfirmed uninstall and replacing install. `ui/src/plugins/attention.test.tsx` holds the words, hidden at 0, after a failed read, while loading and while an SSH instance is unreachable, and one `/api/plugins` request of the instance shown, never before the connections are known. `ui/test/plugins/badge.page.test.ts` drives Chromium over the build: the badge on Models, Workers and Machine at 1440px and 390px with no horizontal overflow (captures in `ui/captures/plugins/`).

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
npx eslint src/plugins/attention.ts src/ticket-mode/plugins-api.ts src/plugins/page-actions.ts ui --quiet
ls ui/captures/plugins/plugins-badge-1440x900.png ui/captures/plugins/plugins-badge-390x844.png'
```

Consumer-declaration: none -- `ui/` is a private package nothing else reads, and `PluginsAnswer` gains fields that `ui.html` ignores; no option is added to a project declaration.
