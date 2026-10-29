---
"agent-org": patch
---

The board thread no longer holds its loop for the herdr calls and the reads it made every pass, which the board's figure "synchronous holds an hour" counted: the pane read of an idle run, the run-directory sweep's listing, the read of herdr's start from the service manager, the start dialog and safety-prompt reads, the prompts to a worker, the closes of a parked run and of a run stopped for an update, a CI budget or a ticket wait, the instance's start, the clones' origins and the organisation's repositories. The journal now names every hold the figure counts (a line for a synchronous call of 100 ms or more, not 250), `board-thread-sync-guard.test.ts` lists the synchronous calls that stay with their loop and a rate, and `scripts/loop-load.ts` fails on any hold of the board thread under a slow `gh` and `herdr`.
