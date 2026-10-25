## What it is

`docs/design/atomaut/PARITY.md`: the inventory of everything today's `src/ticket-mode/ui.html` does, with where Atomaut does it, the ticket, and the board or the `pattern:` that draws it. And what the inventory found missing, restored in `ui/`: on Runs the held, reviewer-off and claim notices and the Pull requests and After-merge checks lists; on Run detail a "What changed in KEY" disclosure, the learns-from line, the proposed edit's text, "Everything this run noted" (the note's full text) and the run's terminal link read afresh when its queue is older than a poll; on Tickets the held notice, a row's label tags, the no-plan mark and "N tickets under it"; on Settings a standalone "Restore the backup of host.json" (and project.json), a row's Details, a provider's hint, Return to default and a Conventions plugin disclosure. The update banner is A11-217's and Publish is A11-218's: their rows name them.

## Acceptance

`ui/test/parity/parity.test.ts` reads PARITY.md and fails when a feature row has no Atomaut page, no ticket key or no board or pattern, and, while `ui.html` exists, when an element id or an imported name of it is in no row. `runs-parity.test.tsx`, `run-detail-parity.test.tsx`, `tickets-parity.test.tsx` and `settings-parity.test.tsx` render each restored feature from fixtures. `parity.page.test.ts` drives Chromium over the real build and writes the captures in `ui/captures/parity/` at 1440px and 390px with no horizontal overflow.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
npx eslint ui --quiet
ls ui/captures/parity/runs-notices-and-lists-1440x900.png ui/captures/parity/run-detail-queued-open-390x844.png ui/captures/parity/tickets-held-and-labels-1440x900.png ui/captures/parity/settings-machine-restore-390x844.png'
```

Consumer-declaration: none -- `ui/` is a private package nothing else reads; no option is added to a project declaration.
