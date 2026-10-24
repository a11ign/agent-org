# A run's event log is kept on the queue by ticket, not on its entry

A run's timeline (A11-219) must include its dismissal or removal, and it must survive every way the board rebuilds a run. But `dismiss` and `remove` delete the queue entry, and `retry`, the review and talk rounds, the next-step run and the update re-queue each build a new entry from the fields they name. So the log is kept beside the entries, as `Queue.runLog`, keyed by ticket. Each ticket's log is capped at its last 200 events, and the logs of the 50 most recently ended tickets are kept. `/api/queue` sends it with the queue (`queueView` spreads the stored queue).

## Considered options

- **A field on `Entry`** (the ticket's own wording). Rejected: a "dismissed" event would be deleted with the entry it describes. Every entry-rebuilding transition would also need code to carry the log, and a missed one silently loses the history.
- **A separate file per ticket.** Rejected: it adds a second store that has to be saved atomically with the queue. The queue file already survives restarts (`saveQueue` writes it beside the old one, then renames it over it).

## Consequences

- A ticket queued again continues its earlier log, so "re-queued" reads in context.
- The queue file grows by at most 200 events for each ticket on the queue, plus 50 ended tickets.
- A transition that records an event is given the time as an optional last argument, and logs nothing without it, so the pure transitions the board and the tests share keep their signatures. Every call the pool and the server make passes it.
