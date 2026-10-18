A pull request whose ticket it completes names that ticket with the tracker's closing keyword (`Closes`), and the worker's brief says so. A pull request that only links its ticket (`Refs`) must say what remains with a `Partial:` line, and `pr:open` refuses a `Refs`-only body without one, naming both fixes. When a completing run's pull request merges while its ticket is still open, the board completes the ticket itself and posts the merged pull request on it. A run declared partial, a draft, and a run whose pull request is open leave their tickets alone. The tests cover the brief text, the refused `Refs`-only create, the accepted partial one, the Linear adapter's `complete`, and the board's backstop, including the refused move that is tried again.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/linear.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/pr-open-ticket.test.ts src/ticket-mode/pool.test.ts
```

Consumer-declaration: none -- the words a worker writes in its pull request body are the tracker's own, and no command, flag or file a host declares changes.
