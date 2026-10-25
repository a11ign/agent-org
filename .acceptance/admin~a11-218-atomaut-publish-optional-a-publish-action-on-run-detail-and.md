## What it is

A11-218, the Atomaut Publish boards, in `ui/`: on a machine with a publisher (`/api/config`'s `publish`) Run detail has a **Publish** button first in its header, and the Runs page has a tick box on each publishable Ready to merge row and a bar "N selected · Clear · Publish selected (N)". Both post `{ keys }` to `POST /api/publish` through one shared hook. On a machine with no publisher none of it is drawn: no button, no disabled button, no tick column, no bar. Run detail gains the Publishing board (amber ring, the publish run's Open terminal, Publish disabled) and the Published board (indigo check, what was posted and when, the Slack message link); a refusal or a failed publish run shows its sentence in the page's error banner under "Not published." The Runs page keeps A11-197's grouping (no "Delivery" heading) and draws Published rows with the new indigo `--color-published` token. The rule is board-view's `publishable()`; nothing in `src/` changes.

## Acceptance

`publish-model.test.ts` holds the pure rules (the config gate, which button a run gets, pruning the ticks, the failed publish run's sentence). `run-detail-publish.test.tsx` holds Publish absent with no publisher, present first in the header with one, a single press posting that run's key, the Publishing and Published boards, and a refusal and a failed publish run shown under "Not published.". `runs-publish.test.tsx` holds no tick or bar with no publisher, tick boxes on publishable rows only, a batch press posting the ticked keys, Clear, the selection pruned on the next read, and a refusal shown with the selection kept. `publish.page.test.ts` drives Chromium over the real build: the five boards at 1440px and 390px with no horizontal overflow (captures in `ui/captures/publish/`), and the 44px hit areas and board colours.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/publish-model.test.ts src/run-detail/run-detail-publish.test.tsx src/runs/runs-publish.test.tsx test/publish/publish.page.test.ts test/tokens.test.ts
npx eslint ui --quiet
ls ui/captures/publish/publish-ready-1440x900.png ui/captures/publish/publish-select-390x844.png'
```

Consumer-declaration: none -- `ui/` is a private package nothing else reads; no option is added to a project declaration.
