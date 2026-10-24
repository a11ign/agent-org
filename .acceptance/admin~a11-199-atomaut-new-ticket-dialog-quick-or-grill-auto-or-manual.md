## What it is

Step 1 of 2 of the Atomaut New ticket dialog: placement in the writer API and the writer's brief, in `src/ticket-mode/`. `POST /api/writer` takes `placement` (`"auto"` or `"manual"`). Auto leaves the project, repository, goal, priority and parent to the writer, which now also chooses the priority; Manual gives the choices the person made, which the writer uses as given, and the writer chooses the rest. A body with no `placement` is read as its choices imply, so `ui.html` is unchanged. A run carries its `placement`, and each ticket a run made carries its title, priority and project for the dialog's Done row. The request's limits move to `writer-limits.ts`, which the page can import. The dialog and the request strip (`ui/`) are step 2.

## What it checks

The brief checks cover the Auto and Manual text and the Priority, Repository and Team lines. The queue checks read a run stored with no placement by the inference, and the board-view checks cover the body the form sends. The server and pool checks (Auto, Manual, an absent or bad placement, Auto naming a choice, and a Manual request started with the agent stubbed and its filed ticket read back) need the project's history, which the acceptance job lacks; they run in CI's `suite` job.

## After merge (who runs it)

The chairman session runs the ticket's After-merge line, in two parts, because the dialog is step 2.

- **After this step merges** (the API, on the agents host's board, through the paired browser or its `/c/<connection>/api/` address): `POST /api/writer` with `{"request": "<a short real request>", "mode": "quick", "placement": "manual", "project": "<a project the host has>", "priority": "low"}`. A pass: `GET /api/writer` lists the run with `placement: "manual"` and the form as sent, it reaches `status: "done"`, its `tickets[0]` has `key`, `url`, `title`, `priority: 4` and the project, and the ticket in the tracker has that project and priority Low. Then `POST /api/writer` with `"placement": "auto"` and `"priority": "low"` must answer 400 `auto placement names no project, repository, goal, priority or parent: send placement manual to name them`, and queue nothing. Cleanup: dismiss the run (`POST /api/writer/<id>/dismiss`) and close the ticket it filed in the tracker.
- **After step 2 merges** (the dialog, on `/next/tickets`): one Quick ticket with Manual placement (a project, priority Low), then one Grill ticket with Auto. A pass: the strip reaches Done with the key and link, and the Manual one has that project and priority Low in the tracker; the Grill one opens its terminal, shows "Waiting for you" with the question, and after the answer shows Done with the key.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/writer.test.ts plugins/linear/writing.test.ts
```

Consumer-declaration: none -- no option is added to a project declaration.
