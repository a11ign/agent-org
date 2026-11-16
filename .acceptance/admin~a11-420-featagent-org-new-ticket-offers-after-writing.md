The New ticket dialog offers "After writing: Keep in backlog / Queue them" below Placement, with "Keep in backlog" chosen in Quick and Grill. "Queue them" sends `after: "queue"` and no model, effort or plan. The server stamps the run with the saved queue defaults (`model`, `effort`, plan on) and refuses any other `after` with a sentence. A run that ends cleanly has its tickets queued in the order it made them, through the same `refuseTaken` and `queueTickets` as `POST /api/queue`, and records how many. A run that ends needs-human, fails, is stopped or files an unreadable ticket queues none and records why. A refusal or a throw still ends the run done, recording "Written, but not queued: <sentence>. They are in the backlog.". The dialog shows the explanation line (with the paused-queue wording), a Queue pill ("plan first" only on a planning board) and "Write and queue". The run card adds "Queues them when done (<model>/<effort>[, plan first])". The Done notification marks each ticket the queue holds "Queued" and says "<n> tickets queued with <model> · <effort>[ · plan first].", or shows the amber note with a "Queue them" button that queues the rest through `POST /api/queue` and goes once they are on the queue. On a 390px touch screen, each new target is at least 44 by 44 px with a focus ring, and the page does not scroll sideways.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/queue.test.ts src/ticket-mode/server.test.ts src/ticket-mode/pool.test.ts src/packaging/project-vocabulary.test.ts -t "A11-420|vocabulary literal"
(cd ui && npx rstest run --config rstest.config.ts --project components src/notifications src/new-ticket)
(cd ui && pnpm run build && npx rstest run --config rstest.config.ts --project pages test/new-ticket)
```

Consumer-declaration: none -- no host file key changes meaning; `POST /api/writer` takes a new optional `after`.
