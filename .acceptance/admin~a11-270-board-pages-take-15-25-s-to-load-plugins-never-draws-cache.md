The queue the pages poll is a list of what they draw, a run's full detail is read on demand, and a test keeps the 1 s first-load budget (A11-270, step 4 of 4): `GET /api/queue` sends each run's list fields and no log (1.3 MB of JSON becomes 0.34 MB and 15 KB gzipped, on a queue shaped like the agents host's), `GET /api/queue/<key>` answers one run in full with its log, the instance gzips long answers for a client that takes gzip, and a run's page draws from the list and fills its steps and timeline in place. `page-timing.test.ts` reads every page's set of reads through the page's proxy over a fake SSH tunnel, against plugin checks that take 5 s or never end and a tracker that takes 0.6 s, and fails over 1 s at p95, over 300 ms for the plugins read, or over a third of the full queue for the queue read.

Acceptance:
```bash
node --test src/ticket-mode/queue-view.test.ts src/ticket-mode/page-timing.test.ts src/ticket-mode/local-http-pack.test.ts src/ticket-mode/remote-proxy.test.ts
pnpm --dir ui exec rstest run --config rstest.config.ts src/api/client.test.ts src/run-detail
```

Consumer-declaration: the board UI (`ui/`, same repository) is the only reader of the list's fields; `GET /api/queue` keeps every field `scripts/board-update-check.ts` reads (`entries[].ticket.key`, `phase`, `toolVersion`, `update`), and the page's service asks for gzip and unpacks it, which an older instance ignores.
