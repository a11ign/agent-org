## What it is

A "Search tickets" palette in the Atomaut shell (`ui/src/search/`), from A11-387. A full-width button ends the sidebar's top group, below the connection pill, with a ⌘K / Ctrl+K hint. The shortcut opens the palette from every page. Neither the button nor the shortcut exists on an instance whose tracker cannot search (`config.search`). The palette reuses `useWorkspaceSearch` unchanged and merges in the runs in the queue, matched by key and title. Each row shows a status dot, the key, the highlighted title, "project · goal · owner" and a status. Rows offer Open ticket and View run. Open ticket hands the ticket to the Tickets page through `localStorage`; the handoff expires and is cleared as soon as it is read. The Tickets page then moves to the ticket's project (where the instance picks projects) and to Anyone, ticks the ticket alone, and shows an indigo banner with Back to my tickets. The palette also lists the 3 tickets opened from it most recently. No backend code changes.

## Acceptance

`ui/src/search/search-palette.test.tsx` covers the entry point, the dialog, the results, the keyboard, the merged runs and the states. `ui/src/tickets/tickets-from-search.test.tsx` covers the handoff and the banner. `ui/test/search/search.page.test.ts` drives Chromium: 44x44 controls and both row actions on a 390px touch screen with no horizontal scroll, the 2px #9aa1f5 focus ring, and a skeleton that does not shimmer under reduced motion.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
npx eslint ui/src/search ui/src/tickets ui/src/shell ui/src/lifecycle/use-modal-focus.ts ui/test/search ui/test/fixtures.ts --quiet
ls ui/captures/search/search-results-390x844.png ui/captures/search/search-from-search-1440x900.png ui/captures/search/search-loading-1440x900.png'
```

Mutation: put back the old `FOCUSABLE` selector in `ui/src/lifecycle/use-modal-focus.ts` (one that does not exclude `tabindex="-1"` buttons and links). The Tab-wrap test in `search-palette.test.tsx` then fails, because the trap's last stop becomes a hidden action on a row that is not active.

Consumer-declaration: none. `ui/` is a private package that nothing else reads, and no host file key, API route or tracker contract changes.
