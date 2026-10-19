A Grill new-ticket run that ends its turn with a question and no outcome file is Waiting for you (A11-129), not failed: the Stop hook records the question beside the outcome file, the board keeps the run's pane and slot, and the person's answer (the agent working again) resumes it. A Grill run fails only when its agent exits, or when nobody answers its question for 4 hours. A worker link whose run has ended answers a page that says so, with a link to the run, instead of a redirect to a terminal that is gone.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/hook.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/terminal-pair.test.ts src/ticket-mode/background-work.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/pool.test.ts
```

Consumer-declaration: none -- the new-ticket writer and the worker link are the board's own paths. The page reads the run's `waiting` and the link's ended answer; both are covered by the files above.
