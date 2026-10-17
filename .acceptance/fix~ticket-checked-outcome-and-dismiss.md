A ticket-mode worker that checked a ticket and found nothing to change ends on `{ "kind": "checked", "reason": "..." }`: the board shows it Checked with its reason, never in Needs you, it is not retried, and the pool closes its workspace as the outcome is recorded (A11-72). The worker brief says when to write `checked` rather than `needs-human`, and both planning briefs say a ticket that is only a parent gets a plan that suggests queueing its children. Every finished run offers Dismiss (`POST /api/queue/<key>/dismiss`, passed on by the page's service): it closes the run's workspace when it is parked and takes the run off the board, leaving the ticket, its branch and its pull requests alone; a queued or live run, and one the publish run under way is posting, is refused (A11-73).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/board-view.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/server.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/reviewer-port.test.ts
```

Consumer-declaration: none -- ticket mode's own board, pool and briefs; `ticket:serve` and the page's service are the only consumers, and both change in this pull request.
