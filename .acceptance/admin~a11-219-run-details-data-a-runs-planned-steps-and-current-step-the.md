## What it is

Step 2 of 2 of A11-219 (step 1, the planned steps, current step and worker, merged in #1865): a per-run event log for the Atomaut Run detail's timeline. The log is kept on the queue by ticket, as `Queue.runLog` (ADR 0013), not on the entry, so it holds "dismissed" and "removed" after the entry is gone and survives every transition that builds an entry afresh. Each pure queue transition that changes a run logs one event through `logEvent` (`src/ticket-mode/queue/run-log.ts`) on a change it already detects: queued, planned, started, round (feedback, checks, conflict, asked, approved, talk, rereview), pr-opened, verdict, needs-you, answered, published, merged, finished, dismissed, removed and requeued (retry, next-step, update, replan). A transition given no time logs nothing, and every call the pool makes gives it. A ticket keeps its last 200 events, and the logs of the 50 tickets that ended most recently are kept. `loadQueue` reads `runLog`, so it survives a restart. `runTimeline` (`src/ticket-mode/board-view/run-timeline.ts`) gives a run stored before the log existed the events its own times rebuild, each `rebuilt: true`, never written to the queue. `/api/queue` sends the log with the queue (`queueView` spreads it, no `server.ts` edit), and `ui/src/api/types.ts` exports `RunEvent` and `TimelineEvent`.

## Acceptance

Acceptance:
```bash
bash -c 'set -euo pipefail
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/run-log.test.ts src/ticket-mode/pool-rereview.test.ts src/ticket-mode/run-timeline.test.ts src/ticket-mode/server.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/pool.test.ts src/packaging/project-vocabulary.test.ts
npm run typecheck
pnpm ui:typecheck'
```

Proof of each line of the ticket's third section: each event once and in order, a whole life from queued to dismissed (`run-log.test.ts`, "a ticket's life is logged as it happens"); a watch reading the same heads and states again adds nothing ("a watch that reads the same heads and states again adds no event"); capped at 200 per ticket and 50 ended tickets ("a log keeps its last 200 events"); kept over a restart ("the log is saved with the queue and read back unchanged"); the pool wires it ("the pool logs what it does to a run"; `pool-rereview.test.ts` "A11-219: a re-review is logged as a round"); old runs show what their times rebuild (`run-timeline.test.ts`); `/api/queue` sends all three fields (`server.test.ts`, "A11-219: /api/queue sends a run's planned steps"). Nothing in the ticket can only be proven after merge.

Consumer-declaration: none -- no option is added to a project declaration. The transitions that log take an optional last `now`, and `Queue` gains an optional `runLog`.
