## What it is

The Atomaut Runs page, in `ui/src/runs/`: `/next/runs` is the four Runs boards (`AtomautRuns`, `AtomautRunsLoading`, `AtomautRunsEmpty`, `AtomautRunsPaused`) over the queue the shell already polls. The sidebar's Run status rail (every status of `RUN_STATUSES` under its head, with `statusCounts`), the worker pool bar (slots, `<busy> of <max> busy`, Change limit, Pause / Start workers through the Settings page's `usePool`), and the runs under their headings: "Running now" for every run holding a worker slot, every other run under its own `shownStatus` label, 50 rows and 50 more for each Load more. A row's note is every line today's card shows, joined with " · ". A row's buttons are exactly the verbs `runActions()` returns, in its order. The loading, empty, paused and error states are the boards'; an SSH instance that cannot be reached is the shared frame. `/next/runs/<key>` stays the shell's placeholder for A11-198. The one shared-shell change is an optional `middle` prop on `ShellFrame`, which puts the rail in the sidebar; the tokens the boards use that `tokens.css` lacked are appended there in one block.

## Acceptance

`runs-model.test.ts` holds the rail's heads to `RUN_STATUSES`, the groups, the paging and footer, the note's lines and their order, the timing words and the token units. `runs-states.test.tsx` covers loading, empty, paused (Start workers posts `/api/paused`), error (Retry, Dismiss, the last good list), unreachable, a filter with no runs, and a remembered filter. `runs-actions.test.tsx` covers a queued, a blocked-on-overlap, a running, a talking, a parked, a draft-awaiting and a finished run: the buttons are `runActions`' verbs with the board's or today's names and titles, a press posts `/api/queue/<key>/<verb>` and reads again, a refusal shows its sentence, Talk to it opens and points a tab, and Send back for changes and Comment are never drawn. `runs.page.test.ts` drives Chromium over the real build under `PAGE_CSP`: the five states at 1440px and 390px with no horizontal overflow (captures in `ui/captures/runs/`), a rail choice, Load more, and a row's action request.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
npx eslint ui --quiet
ls ui/captures/runs/runs-ready-1440x900.png ui/captures/runs/runs-loading-390x844.png ui/captures/runs/runs-empty-1440x900.png ui/captures/runs/runs-paused-390x844.png'
```

Consumer-declaration: none -- `ui/` is a private package nothing else reads; no option is added to a project declaration.
