# The code host's sweep reads answer a promise, and a repository's pull requests are read once

A11-282 moved the board's HTTP server off the loop the sweeps run on, but the sweeps themselves still ran `gh` synchronously through the GitHub plugin: in ten minutes on 2026-10-27 the board logged 755 holds of about a second each, so its own thread was held almost all the time. Requests were answered, from a snapshot the held thread could not refresh, so cards showed state minutes old, queue writes landed long after the call and the tracker's pooled sockets went stale (A11-356).

## Decision

The reads the sweeps make on every pass answer a promise (code host contract 1.29): `readOwnLogin`, `readPullFeedback`, `readReviewState`, `readReplies`, `readPullState`, `openPullUrlsOf`, `readBranchCi`, `openDependencyPulls` and `readMergedFindings`. The GitHub plugin runs them through `deps.execAsync`. The pool's sweeps (`watchFeedback`, `reviewNewHeads`, `startGreenReviewers`, `releaseReviewers`, `retargetStacked`) became async, and the server runs each one at a time: a sweep whose last turn has not settled is not started over itself (`startFeedbackSweeps`).

The plugin reads a repository's open pull requests with one `gh pr list` and shares the answer between every pull request of it and every caller for ten seconds (`shared-reads.ts`, `reviews.ts`), where each caller read each pull request with a `gh pr view`. A pull request the list does not hold is read on its own.

`plugins/github/sync-gh-guard.test.ts` refuses a synchronous spawn under `plugins/`, requires the reads above to reach `deps.execAsync` and never `deps.exec`, and names every operation that still runs `gh` synchronously.

## Considered options

- **Every contract method a Promise at once** (ADR 0014's option): about 110 call sites in the pool, the ticket port and row mode, in one change. The reads above are the ones the board makes on every pass and were in the log; the writes and the reads done on an event stay synchronous and are the next step, each listed with why in the guard test.
- **Answers from a cache the plugin keeps warm, with the contract unchanged**: a sweep would read what the last sweep asked for, and a cold read would answer `null`. It leaves the board reading state a sweep old, which is what the ticket's cards already showed.
- **A worker thread for the plugin's reads**: it moves the hold off the board thread, but a sync answer still has to come back across the thread, so the caller waits as before.

## Consequences

- A sweep that reads many pull requests no longer holds the board's loop, and its reads are made a few at a time (`pool-reads.ts`) so a thirty-pull-request sweep does not start thirty `gh` at once.
- The reviewer plugin starts a reviewer for the state the sweep has just read (`peekReviewState`, optional), since `ReviewerPort.start` was synchronous. It no longer is: ADR 0016 (A11-379) made the reviewer port, and the code host's claim calls, answer a promise.
- `end()` records a finished run's pull requests' files and heads after the reads return. Until then the run is finished with its files unrecorded, the state a read that failed already left, in which `overlapWait` holds its repository.
- A read shared for ten seconds can be ten seconds old, where it was read at the call. The sweeps run every minute or two.
