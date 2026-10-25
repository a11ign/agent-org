Refs A11-272

Step 1 of 3. A run whose worker declares a `ticket` wait on a ticket that is not done gives up its slot and its files. The board records that ticket as a blocker in the tracker, closes the run's workspace and queues the ticket behind it with its Claude session. The run is held until the ticket is done, then resumes that session. A run never holds its files against a ticket it waits on, directly or through the tickets those wait on. A fleet job or CI run names no ticket, so a run parked on one still holds its files against the others.

Acceptance:
```bash
# The A11-231/A11-229 shape through the board's tick: the deadlock reproduced; the parked run released (tracker blocker, workspace closed, queued with its session) and NBF-2 started on the files; the resume on its own session once NBF-2 is done; a tracker with no addBlockers still holding it; a workspace herdr will not close left running; a ticket already done woken as before.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-ticket-wait.test.ts src/ticket-mode/pool-wait.test.ts
# The pure pieces: the re-queue transition and its hold (never stacked, held by the stop's record until the tracker lists it, let go once done); the waits-on graph; the overlap exemption for ticket, pull request and transitive waits, while a fleet job or CI run still holds.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/queue/queue-blocker-wait.test.ts src/ticket-mode/board-view/waits-on.test.ts src/ticket-mode/overlap-hold.test.ts
# What it must keep: the update drain's stop and resume, which now shares the re-queue body.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/update-drain.test.ts
```
Run with `AGENT_ORG_HOST` naming a host declaration, as CI's `suite` job does (the fixture project copied to a temporary directory).

After merge: none for this step. Step 2 carries the ticket's After-merge check (no ticket `running` with a `waitingOn` ticket, none `queued` behind a parked run's files) as a command over the live queue.
