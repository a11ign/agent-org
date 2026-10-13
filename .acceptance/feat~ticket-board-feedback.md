A ticket-mode run settles from its pull requests' states as Linear's GitHub attachments report them (`pullStates` and `pullState` in `src/ticket-mode/linear.ts`, `settledByPulls` and `runStatus` in `board-view.ts`, `recordPullStates` and `unsettledKeys` in `queue.ts`, `refreshTracker` in `pool.ts`), the filter rail's In progress icon is a still dot (`RAIL_ICONS` in `ui.html`), and Pick nests a ticket under its parent, with a parent that is not the person's as a context node (`ticketTree`, `groupByStatus` and `flatten` in `board-view.ts`, `GET /api/parents` in `server.ts`, `renderPick` in `ui.html`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode
```

Consumer-declaration: none -- a source without `pullStates` settles runs from its tickets as before; `/api/parents` is a new read-only route; the page changes only how it draws.
