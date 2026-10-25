# Wake on event

A worker only thinks when something wakes it. A worker that hands its own wake-up to a loop it wrote (`until ! pgrep -f capture_fleet.py`) can sleep for hours when the loop never ends (A11-229 slept for 11 hours on 2026-10-24: the pattern matched the loop's own command line). So a worker declares what it waits on and ends its turn, and the board does the waiting and prompts the worker's pane.

## What the worker writes

A `working` outcome may list the events it waits on, and by when:

```json
{ "kind": "working", "reason": "the capture runs on the fleet",
  "waitingOn": [ { "fleetJob": "<id>" } | { "ciRun": "<owner/repo>#<runId>" } | { "pullRequest": "<url>", "until": "merged|reviewed" } | { "ticket": "<KEY>", "until": "done" } ],
  "until": "<ISO time>" }
```

- Each item has exactly one subject key. `until` is required on a `pullRequest` and a `ticket` item and refused on the other two: there it names the event waited for. The top-level `until` is the deadline of the whole wait.
- One to 20 items, repeats dropped. Items are checked for shape only when the file is written (`src/ticket-mode/wait-on/wait-parse.ts`); whether the job, run, pull request or ticket exists is the board's reading.
- With no top-level `until` the deadline is 3 hours after the outcome file's time, so a newer `working` outcome starts it again. There is no cap.
- `waitingOn` as a **string** is a different thing: free text naming background work the worker's own shell or Monitor holds (A11-236). The board cannot read it, so it only watches its bound. A plain `working` with neither is valid as before.
- The stop hook lets a declared `working` stop with no shell or Monitor running, since the board wakes the worker. A second stop on the same file after the board woke the worker is refused, as for any `working`.

## What the board does

For a running run whose agent is idle or done and whose note declares events:

1. **Reads them**, off the tick, at most once a minute per run, one call per item not yet over. An item that has finished or failed is never read again. A fleet job is `fleet job status <id> --json` (30-second timeout); a CI run is the code host's `readCiRun`; a pull request is `readPullState` (and, until `reviewed`, `readReviewState`: an `APPROVED` or `CHANGES_REQUESTED` review on the current head finishes it, and `CHANGES_REQUESTED` is a finished review, not a failure); a ticket is the tracker's `stateTypes` (`completed` finishes it, `canceled` fails it). A read that says nothing, throws or runs out of time is **unreadable**: pending, never a failure, and the card says why.
2. **Judges** (`wait-verdict.ts`): all items finished means the wait is finished; any item failed means it failed at once, with the others still pending; otherwise it is pending.
3. **Wakes once.** On finished or failed it prompts the worker's pane (`herdr agent prompt`) with what happened per item: a job's state and where its results are, a run's conclusion, a pull request's or a ticket's state, the reason first on a failure. It tells the worker to act on it and not to declare the same wait again. The note's `woke` is written **before** the prompt is sent, so a restart or a repeated tick never sends it twice. A prompt herdr refuses is tried again on the next tick, up to 3 times, after which the run is marked Stalled with the refusal.
4. **At the deadline** with items still pending, it waits for a reading taken at or after the deadline, prompts the worker once with each pending item's progress (`woke.why` is `late`), and marks the run Stalled if it is still idle `tickets.stallMinutes` after that with nothing newer. No new setting: the existing one is the grace.

A worker that is woken for a finished or failed wait and then writes a `working` that declares only items it was just told had ended is **a repeat**: no wake is sent for it and the run is marked Stalled (`re-declared a wait that had already ended`), so a worker that ignores the prompt cannot loop the board.

A newer `working` outcome is a new note, with a fresh deadline and a fresh wake.

## A ticket wait lets the run go (A11-272)

A ticket can take hours or days, and a run left `running` that long holds a slot and its whole footprint: on 2026-10-25 A11-231 waited on A11-229 while A11-229 was held behind A11-231's files. So a `ticket` item is not waited on in the pane. Once the wait's reading is pending and finds a ticket not done, the board (`pool-ticket-wait.ts`, on the tick before slots are filled):

1. records that ticket as a blocker of this one in the tracker (`addBlockers`; a tracker that cannot, or refuses, is said in the log);
2. closes the run's workspace, as an update's drain does (a workspace herdr will not close is left running and tried again next tick);
3. queues the ticket again behind it (`requeueBehindBlocker`, `queue/queue-blocker-wait.ts`), with the Claude session its agent had, and `stoppedForBlocker` naming the tickets and the wait's other items.

The queue holds the run until the tracker reads each of those tickets completed or canceled (the wait's own reading's end), through the tracker's relation and, until the tracker lists it, through `stoppedForBlocker` itself, whose tickets the board reads at most once a minute. It never stacks on them, and merged pull requests that leave a ticket open do not let it go, so the worker is not resumed into the wait it declared. When they are done the run starts like any queued run, but it resumes its own session, so the worker that declared the wait is the one that carries on. Its brief lists the blockers and their pull requests. A ticket wait whose ticket is already done when first read is an ordinary declared wait, and the worker is woken for it as above. So is a batch's run, which its tickets share.

A run never holds its files against a ticket it waits on (`board-view/waits-on.ts`): a ticket its idle worker's note declares a wait on, the ticket whose run on the board has a pull request it waits on, and its blockers not yet done, each followed through the tickets those wait on. A worker woken from its wait, or at work again, holds its files as before. A fleet job or a CI run names no ticket, so a run parked on one still holds its files against the others.

## A wait cycle is found, broken and told once (A11-272)

A **wait cycle** is two or more tickets that each wait on another: through a blocker, through the files a run holds, or through a wait the idle worker declared. `board-view/wait-cycles.ts` reads the whole board as one graph (a ticket is a node; an edge says `A` cannot go on until `B` does, as `blocked-by`, `files` or `waits-on`) and returns each strongly connected group of tickets. The `files` edge counts the hold as it would be without the exemption above (`overlapHolders`), so the 2026-10-25 shape, a run waiting on the very ticket held behind its files, is a cycle even though the exemption lifts that hold. A fleet job and a CI run name no ticket and add no edge.

On every tick, before slots are filled, `releaseTicketWaits` finds the cycles and lets go, at once, each run in one whose idle worker declared a ticket wait on another ticket of the cycle: a ticket on the board in the same cycle is not done, so the wait's first reading is not needed. What it cannot release is named and left as it is: a cycle of blockers alone, a pull request wait, a batch's shared run. Then `pool-wait-cycles.ts` tells the chairman's session, once: one tracker comment on the cycle's smallest key saying what the board did, or that a person must remove one blocker relation, and a log line. It is posted once the board has done what it can (a workspace herdr will not close is told after it closes), and recorded in `tickets/wait-cycles.json` in the state folder only after the tracker took it, so a refused comment is tried again. A cycle the board no longer finds is removed from the record, so one that forms again is told again.

The cards name the cycle: a ticket in one reads `in a wait cycle: A11-229 → A11-231 → A11-229`, and the Runs page shows one banner for each cycle, which goes when the cycle does. A queued ticket held by an overlap reads `Waits on A11-231 #12: both touch ...`, naming the holder.

## What each state reads like

| The run is | The card says |
| --- | --- |
| Waiting, inside the deadline (declared) | status **Waiting**, never In progress or Working. `Waiting on fleet job fj-123 (4 of 6 pages, about 20 min), until 16:30`; several items joined with `; `: `Waiting on fleet job fj-1 (done); CI run a11ign/x#9 (running, 3 of 5 jobs), until 16:30`; an unreadable item `(could not read it: <why>)`. The deadline is the `until` the outcome gave, else 3 hours after it (`board-view/wait-deadline.ts`), and a wait past it still says when it was due. Never Stalled, however long it has been idle. |
| Waiting on its own shell or Monitor (undeclared), inside the deadline | status **Waiting**: `Waiting on background work for 54 min: <waitingOn or reason>, until 16:30` (A11-236) |
| Woken, no newer outcome yet | its reason, as any `working` note |
| Past the deadline, woken, still idle | `Stalled: waited past <deadline> on <what was pending> since it said: <reason>` |
| Declared a wait that had already ended | `Stalled: re-declared a wait that had already ended: <items> since it said: <reason>` |
| Its wake prompt was refused 3 times | `Stalled: could not wake the worker: <herdr's reason> since it said: <reason>` |

A11-85's rule (a pane that shows no background work for 3 minutes marks the run Stalled and prompts the worker once) still holds for an undeclared wait. A declared wait ignores the pane: the worker has nothing of its own running, and an empty pane is expected.

## Where it lives

`src/ticket-mode/wait-on/`: `wait-parse.ts` (the shape check), `wait-read.ts` (one reader per kind, over injected seams), `wait-verdict.ts` (pending, finished or failed, and each item's words), `wait-text.ts` (the card's line), `wait-note.ts` (what a waiting note looks like at a moment), `wait-watch.ts` (the polling), `wait-prompt.ts` (the prompt's words and its sending). The tick calls them from `watchStall` in `pool-watch.ts`.
