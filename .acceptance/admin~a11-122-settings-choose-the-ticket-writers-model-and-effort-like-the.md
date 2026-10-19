Ticket mode's Settings page chooses the ticket writer's model and effort beside the worker's and the planner's (`ui.html`, the "Ticket writer" fieldset). A choice is stored in `choice.json` as `writerModel` and `writerEffort`, and an empty value clears it, so the host file's `tickets.writer.model` and `.effort` are in force again (`POST /api/choice`, `CHOICE_PARTS` and `applyChange` in `server.ts`). `POST /api/writer` stamps each new-ticket request with the model and effort it runs on (`queueWriter` in `queue.ts`, `WriterRun` in `queue/declared-remains.ts`), and `startWriter` in `pool-start.ts` starts the run on that stamp, falling back to the host file's for a request queued before it. `GET /api/config` carries `writerDefault`, and a writer run's card shows its `model/effort` (`writerChoiceLabel` in `board-view.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/server.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/ui.test.ts
```

Consumer-declaration: none -- the two keys in `choice.json` are optional, and a `choice.json` without them, or a `queue.json` whose new-ticket requests carry no stamp, reads as before.
