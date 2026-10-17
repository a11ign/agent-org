A ticket the board moved to its working state goes back to the state it came from when its run ends without a pull request: stopped, crashed, checked, or removed from the queue as a retry, or dismissed. A run that ends needs-human, wrong-repo or with no outcome keeps the ticket In Progress while it is parked, and Dismiss puts it back; Close does not. A run that opened a pull request is never put back. A person who moved the ticket since is left to it. The move and its record are kept on the queue entry (`movedFrom`), recorded by the first move and carried over a retry, and a restore the tracker refuses is logged and kept for the next refresh, while Remove and Dismiss throw with the reason. The tests cover each path, the person-moved case, the refused restore, and the restore that waits for its move.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/linear.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/server.test.ts src/ticket-mode/ui-server.test.ts
```

Consumer-declaration: none -- the board's own tracker state for its tickets; no command, flag or file a host declares changes.
