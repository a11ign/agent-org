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
- The board thread's own holds are counted, and `/api/health` names the call sites that cause them (`blocking`, with the herdr and GitHub seams skipped so the site is the code that asked). They are what a write, and `GET /api/session-asks`, wait behind, and what the board's reliability figure "synchronous holds an hour" counts (A11-282, reopened 2026-10-28 at 26 an hour against a threshold of 10).

## Taking the board thread's own calls off its loop

The request thread made reads independent of the board thread; it did not make the board thread's calls cheap. After it merged the board thread still held its loop for every synchronous `gh`, `git` and `herdr` call its tick and sweeps made, which delayed writes and `GET /api/session-asks`, and counted as holds. The calls are being made asynchronous one family at a time, each as an OPTIONAL asynchronous twin in the contract (a minor bump, code host 2.2, so an older plugin still works and is read through its synchronous operation), asked first by the pool:

- the start-up check of the `gh` wrapper (a child process of this Node, not a synchronous one);
- the tick's two herdr listings (`workspace list`, `agent list`): `readAgentsAsync` over `herdrAsync`;
- the clone sweep's listing of the organisation: `repositories.readRepositoriesAsync`;
- the sweep of the stacked pull requests' bases: `sweepRetargetsAsync`.

What still holds the board thread, by the live ledger of 2026-10-28 (calls of 250 ms or more): the reviewer's start (its checkout with `git` and `pnpm`, its token mint, its claim on the head with `gh`, its `herdr` workspace), the stack merge's reads, the merge flow's reads and the check-run reads. The reviewer's start is the largest family and is A11-379's: its first step (the asynchronous forms of the steps that spawn a program) has merged, and its second wires the reviewer port to them. The rest is listed in the pull request that made this change, with the ledger's times, for whoever takes the next family.

## The pool's herdr calls at the start and end of a run (A11-282, step 4)

The ticket was reopened on 2026-10-29 with the figure at 14 an hour. After step 3 the held-loop lines were mostly the reviewer's start (A11-379), the GitHub plugin's event operations (A11-395) and the pool's own `herdr` calls at the two ends of a run. Those are taken off the loop here: the close of an ended run's workspace (`closeWorkspaceLater`, `pool-close.ts`; its note was dropped at every call site, so nothing waited on it) and a start's pane, agent listing and close on failure (`startAgent`, `settleStart`).

- They go through `ctx.herdrCall`, over `herdrRunAsync`, which carries herdr's own stderr on the error as `herdrRun` did. `defaultHerdrAsync` is left bare, because `agent start`'s busy-pane retry reads its error as it is.
- The close is no longer finished when the code after it runs, so the pass's `fill` and every start wait for the closes that are out (`closesSettled`): a run queued again never opens a workspace beside the one it replaces, and `settleSessions` never reads a workspace that is closing. The pass waits, the event loop does not.
- An instance that ends waits for the closes it asked, at most `CLOSES_WAIT_MS`, before it exits.
- Still synchronous, by the same ledger: `sweepRunTmp`'s `workspace list`, the pane read of a run the tick finds not working, the start dialog's `agent read` and `send-keys`, and the workspace close of an unparked run (which reports its failure). Each is rare and each is listed in the pull request.
