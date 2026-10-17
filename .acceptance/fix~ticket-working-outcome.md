A ticket-mode worker whose own background work is still running when it ends a turn writes `{ "kind": "working", "reason": "..." }` (A11-80). The Stop hook lets one stop through on it and refuses a later stop on the same file, bounded by the same count as a missing outcome. The pool does not end, park or close such a run: it stays In progress, holding its slot and watched, with the reason as its latest note, and the next outcome replaces the note as usual; a parked run whose worker writes `working` is live again. After `tickets.stallMinutes` (default 30, validated by name) of idle with no newer outcome, the board flags the run Stalled with that note and logs it once, without ending or prompting it. The worker brief says when to write `working` rather than `needs-human`.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/hook.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/worker-files.test.ts src/no-project-names.test.ts
```

Consumer-declaration: none -- ticket mode's own hook, pool, board and briefs; `ticket:serve`, the page and the workers it starts are the only consumers, and all change in this pull request.
