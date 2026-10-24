## What it is

The Atomaut Tickets page, in `ui/src/tickets/`: today's Pick tab (the list by status, the Assignee group, the search, the Priority, Plan and label filters, selecting, Queue, Queue its children and Grill) drawn as the four Tickets boards draw it, with the queue options (Plan first, Model, Effort, Change defaults, Reset) in a popover behind the Options cog of the queue bar, a New ticket button that is present and disabled until its dialog lands, and the loading, empty, paused and error states. `ShellProvider` now holds the Assignee scope (and reads other scopes' pages, who holds the rest and the parents on demand, as `ui.html` does), so the sidebar's counts, projects and goals follow it. The page remembers its choices under `ui.html`'s own keys. No instance API changes.

## Acceptance

The component checks (happy-dom) drive the page over a stand-in instance: sections, rows and every row variant (parent, decision, goal, on the queue, taken, owner), search, the Assignee segments moving the sidebar's counts, the Priority, Plan and label menus and what they remember, Select all, a row and a parent's tick, the queue bar, queueing from the popover (the cog opening it, Model, Effort and Plan first changing the Custom pill, Reset, Queue posting `/api/queue` with the keys, model, effort and plan and clearing the selection and reading the queue again), Queue its children's notice, Grill, and each state (loading skeleton, empty with Show anyone's tickets choosing Anyone, paused with its link, error with Retry and Dismiss, unreachable). The page checks drive Chromium over the real build: every state, queueing from the popover end to end with the posted body checked, and no horizontal overflow at 1440px and 390px for the four boards' states (which also writes the captures to `ui/screenshots/`).

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
npx eslint ui --quiet
ls ui/screenshots/next-tickets-ready-1440x900.png ui/screenshots/next-tickets-loading-390x844.png ui/screenshots/next-tickets-empty-1440x900.png ui/screenshots/next-tickets-paused-390x844.png'
```

Consumer-declaration: none -- `ui/` is a private package nothing else reads; no option is added to a project declaration.
