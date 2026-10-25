# The instance answers requests on a thread of its own, and the board thread stays the queue's one writer

The instance ran its HTTP server and its background work (the tick, the tracker refresh, the sweeps) on one event loop. Every synchronous `gh`, `git` and `herdr` call the background work made stopped every request, for up to 60 s (A11-282). We moved the HTTP server into a `worker_threads` worker, the request thread. It answers reads from a snapshot the main thread, the board thread, posts after every change, and it forwards writes whole to the board thread's existing routes. The board thread keeps the pool and stays the queue's one writer.

## Considered options

- **An asynchronous `exec` in the plugin contract.** The code host contract and the pool's `gh` seam are synchronous by design. Making `exec` asynchronous turns every contract method into a Promise: a major bump of every concern, across 362 call sites. It stays a possible later step, for writes.
- **The pool in a worker.** This splits the queue's one writer, because the handlers and the pool share the queue in memory, and it turns every write transition into a remote call.

## Consequences

- A read can show state as old as the board thread's longest blocked stretch, and `/api/health`'s `boardSnapshotAgeMs` says how old it is.
- A write still waits while the board thread is blocked.
- `GET /api/session-asks` is answered by the board thread, so it waits too: it marks the checks it lists as sent, and the After-merge checks file has one writer. A session reads it, never a board page.
- A module the request thread imports must not spawn synchronously: `request-thread-guard.test.ts` holds that, with its exceptions listed.
