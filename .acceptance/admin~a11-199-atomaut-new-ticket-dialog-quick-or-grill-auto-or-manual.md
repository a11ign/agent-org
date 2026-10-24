## What it is

Step 1 of 2 of the Atomaut New ticket dialog: placement in the writer API and the writer's brief, in `src/ticket-mode/`. `POST /api/writer` takes `placement` (`"auto"` or `"manual"`). Auto leaves the project, repository, goal, priority and parent to the writer, which now also chooses the priority; Manual gives the choices the person made, which the writer uses as given, and the writer chooses the rest. A body with no `placement` is read as its choices imply, so `ui.html` is unchanged. A run carries its `placement`, and each ticket a run made carries its title, priority and project for the dialog's Done row. The request's limits move to `writer-limits.ts`, which the page can import. The dialog and the request strip (`ui/`) are step 2.

## What it checks

The brief checks cover the Auto and Manual text and the Priority, Repository and Team lines. The queue checks read a run stored with no placement by the inference, and the board-view checks cover the body the form sends. The server and pool checks (Auto, Manual, an absent or bad placement, Auto naming a choice, and a Manual request started with the agent stubbed and its filed ticket read back) need the project's history, which the acceptance job lacks; they run in CI's `suite` job.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/writer.test.ts plugins/linear/writing.test.ts
```

Consumer-declaration: none -- no option is added to a project declaration.
