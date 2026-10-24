## What it is

The Atomaut Settings pages, in `ui/src/settings/`: today's Settings page split into Models, Workers and Machine as the ten Settings boards draw them. Model and effort choices and the worker pool save as they change. Host-file keys stage inline and go through the existing preview, save and restore (the unsaved-changes bar, the review dialog, the tick box for a dangerous key, and the saved, refused-by-the-readers and file-changed banners), unchanged in the backend. A remote instance's keys stay read-only with today's note. The one backend change is in `src/ticket-mode/settings-view.ts`: each row carries the `page` of the split it is on (from `settingsPageOf`), and its schema `default` and `inForce` words, which the boards' rows say.

## Acceptance

`settings-view.test.ts` places every schema entry's row on a page. The component checks (happy-dom) cover the three pages, save-on-change and its refusals, the worker pool, staging, the review flow, a dangerous key, refused, conflict, saved and restore, a remote instance, and the loading, error and unreachable states. A node check holds the conflict sentence the page keeps to the one `saveEdit` throws. The page checks drive Chromium over the real build: the ten boards' states at 1440px and 390px with no horizontal overflow (captures in `ui/captures/settings/`), and the Plugins entry of the sub-nav.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
npx eslint src/ticket-mode/settings-view.ts ui --quiet
ls ui/captures/settings/settings-models-1440x900.png ui/captures/settings/settings-review-390x844.png ui/captures/settings/settings-unreachable-390x844.png'
```

Consumer-declaration: none -- `ui/` is a private package nothing else reads, and `Row` gains fields that `ui.html` ignores; no option is added to a project declaration.
