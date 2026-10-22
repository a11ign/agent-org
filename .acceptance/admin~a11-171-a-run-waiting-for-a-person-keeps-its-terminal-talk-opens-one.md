## What it is

A batch planner that wrote a `QUESTION.md` for some of its tickets closed its own pane, so each ticket's "Open terminal" opened a deleted pane; Talk on one ticket of the batch closed the Talk pane another had opened, because the cards shared one herdr name; a talk session read as Planning (it carries its planning run's `plan`); and a second press queued a second session. This change keeps a run that waits for a person open until the person answers or dismisses it, makes Talk one pane per run (a batch is one run), shows Talking on the card, and has every card of a batch say it shares the one terminal.

## Change

- `pool-settle.ts`: `attachBatch` parks the tickets it hands back on the batch's workspace and pane instead of closing it (the workspace is closed only when none is handed back), and a re-settle after the person's answer reads `order.json` against every ticket the batch was planned with and records relations only for the tickets settled now.
- `pool-sessions.ts`: a parked run's pane is never a leftover; a queued round or Talk waits ("Waits for the person to answer in <workspace>"), and a batch's queued sessions are settled once per run.
- `pool-start.ts`, `queue/talk.ts`: Talk on a batch's ticket queues every ticket of the batch that offers Talk and starts them in one pane; Talk on a run that has a session queued, running or parked changes nothing.
- `queue/queue-transitions.ts`: a parked talk session stays a talk session (with the run it replaced) until its pane is closed.
- `board-view/`, `ui.html`: the Talking status, Talk offered while a session holds its pane, the shared-session note, and a Talk press that opens the browser tab named for the run.
- `worker-files.ts`, `README.md`: the batch brief tells the planner a person may answer after a `planned` that left a question; the README says the same.

## How it is proven

Each acceptance line of the ticket is proven by a named test:

- a run that waits for a person keeps its pane: `a single planner that ends needs-human keeps its pane, and its card links to it`, `a batch planner that leaves a QUESTION.md keeps its pane, parked for every ticket it handed back, and the planned tickets leave the batch`, `a parked batch answered in its terminal settles its remaining tickets, reading the order against every ticket it planned`, `a queued talk session or round never closes a parked run's pane: it waits, saying so` (`pool.test.ts`);
- Talk opens or focuses one pane and says talking: `Talk twice opens one pane`, `Talk on two tickets of one batch opens one pane for both`, `a talk session shows talking, never planning, while it runs and while it waits for the person` (`pool.test.ts`), `Talk opens the run's named terminal tab, and a second press goes to the same pane`, `Talk on a card of a batch opens the tab named for the batch, which every card of it shares` (`ui.test.ts`);
- a batch's cards say they share one session and link to one pane: `a batch's cards say they were planned together, name each other, and link to one pane` (`ui.test.ts`), `A11-171: a batch's tickets that wait for a person on its one pane say so, naming the others that share it, and nothing else says it` (`board-view.test.ts`).

Acceptance:
```bash
npm run lint
npm run typecheck
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/worker-files.test.ts
```

History: full

`pool.test.ts` imports the pool, whose import closure reads `git log` (the host-drift notes), so this run needs the full history the checkout would otherwise lack.

Consumer-declaration: none -- `batch` and `talk` on a queue entry were already stored and sent to the page, which now reads them; a queue file written before this change reads as before.
