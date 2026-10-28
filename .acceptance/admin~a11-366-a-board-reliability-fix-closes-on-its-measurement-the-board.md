A ticket labelled `board-reliability` names one figure of `GET /api/health` and a threshold in a `Figure:` line of its `## Done-when`. The board watches that figure from the release that carries the fix, for the ticket's window (7 days unless the line says otherwise); when a reading reaches the threshold it moves the ticket out of its completed state once, posts the readings on it, and queues it on the saved default model and effort. A11-282 (synchronous holds under 10 an hour) and A11-345 (Linear failures under 1%) are held to figures the board keeps for them, and are reopened at the first sweep if the figure is already over. Doctor lists each open reliability ticket with its current figure (A11-366).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/reliability/figures.test.ts src/ticket-mode/reliability/watch.test.ts src/ticket-mode/reliability/sweep.test.ts src/ticket-mode/reliability/rows.test.ts src/install/doctor.test.ts
```

Consumer-declaration: none -- no host file key changes meaning. The board writes `reliability-watches.json` beside `after-merge-checks.json` in its tickets directory; a ticket reopens only by the tracker's `restoreState`, into the tracker setting `workingState` of the host file (Todo when it names none).
