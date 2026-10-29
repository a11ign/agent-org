# The code host's event operations answer a promise

ADR 0015 made the reads the board's sweeps make on every pass answer a promise, and left "the writes and the reads done on an event" synchronous as the next step. Each of those still held the board's loop while `gh` ran: reading a merge queue failure or a check's log, rerunning checks, updating, closing or commenting on a pull request, the stack merge, the CI run reads and the listing of a ticket's pull requests (A11-395).

## Decision

At the next code host contract major (4.0, after the claim calls' 3.0), `readQueueFailure`, `holdFromQueue`, `readDefaultBranchRed`, `readMergeFlow`, `readClosedWork`, `pullsNaming`, `sweepRetargets`, `stackMergeFactsOf`, `requestStackMerge`, `readCiRun`, `readCheckLog`, `rerunFailedChecks`, `rerunRuns`, `updateBranch`, `closePull` and `commentOnPull` answer a promise. The GitHub plugin runs them through `deps.execAsync`, and the board awaits each one where it called it, one at a time as before. `sweepRetargetsAsync` (2.2) is folded into `sweepRetargets`. Doctor's `merge flow` row reads through `deps.execAsync` too.

`armMerge` stays synchronous and is the one entry left in `sync-gh-guard.test.ts`'s `STILL_SYNCHRONOUS`: it belongs to `CodeHostPort`, the ticket port's contract, and nothing on the board's loop calls it.

## Considered options

- **Optional async twins beside the sync operations**: no break, but two forms of each operation in the contract, and the board is every operation's only caller.
- **Leaving the event operations synchronous**: they fire only on events, but each one is a "held the loop" line, and A11-362's target counts every hold.

## Consequences

- The pool's helpers between these operations and the sweeps become async; a call inside `.map`, `.filter` or `.some` became an awaited loop so the order of writes is kept.
- The pool's `respond` answers a promise, and the server awaits it.
