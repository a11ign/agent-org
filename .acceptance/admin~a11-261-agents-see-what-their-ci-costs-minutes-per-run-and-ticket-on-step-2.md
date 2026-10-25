# A11-261, step 2 of 3: the board reads CI spend, keeps totals, shows them, warns, and holds

The code host contract is 1.22: an optional `readBranchCi` reads the workflow runs on a ticket's branch with each job's runner labels and times (`plugins/github/ci-spend.ts`; the in-memory host and the conformance suite carry it). The board (`src/ticket-mode/ci-spend/`) weights a job's minutes, rounded up, by its labels as GitHub bills (macOS ×10, Windows ×2, other hosted ×1, self-hosted 0), sums them per head, run and ticket, keeps them on the queue by ticket (a completed run is read once), and sends each card `CI: 3 pushes, 48 jobs, ~184 min` (+ the ticket's total when it differs, + the budget when over it). `tickets.ciBudgetMinutes` (300; 0 is none) warns the worker once in its pane and, at twice the budget and at each further whole budget, holds the run: a live run is stopped and queued again keeping its session, held through one pass of the board, and started with the reason and the push-once rule at the head of its brief. Step 1 (the push-once rule, the reviewer's finding) is merged; step 3 (the amber line) is the next pull request.

Acceptance:

```bash
# weigh.test.ts: minutes per head and per OS weight (macOS ×10, Windows ×2, self-hosted 0, rounding up per job, pushes by distinct head, run and ticket totals)
# budget.test.ts, store.test.ts, hold.test.ts, view.test.ts: the warning and the hold thresholds (once, at 2× and each further budget, 0 is none), the settled runs, the held run's two passes, what the page is sent
# ci-note.test.ts: the card's wording; ci-spend.test.ts, conformance.test.ts, code-host.test.ts: the GitHub plugin's reads and the contract's two new checks
# rules.test.ts: the brief text (the rule, and the held section); settings.test.ts: tickets.ciBudgetMinutes; queue.test.ts: a review round keeps what it kept
# The sweep against the in-memory code host (src/ticket-mode/ci-spend/watch.test.ts: the warning in the live pane, the hold at 2× with the card's reason and the next round's brief, a budget of 0, a host without readBranchCi)
# and /api/queue's `ci` (server.test.ts) run in the suite job: they build a pool, which reads the repository's history.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ci-spend/weigh.test.ts src/ticket-mode/ci-spend/budget.test.ts src/ticket-mode/ci-spend/store.test.ts src/ticket-mode/ci-spend/hold.test.ts src/ticket-mode/ci-spend/view.test.ts src/ticket-mode/ci-spend/rules.test.ts src/ticket-mode/board-view/ci-note.test.ts plugins/github/ci-spend.test.ts plugins/github/conformance.test.ts plugins/github/index.test.ts src/plugins/fakes/code-host.test.ts src/plugins/built-in.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/queue.test.ts
npm run typecheck
```

After merge, the chairman session runs the ticket's check on the live board (the instance's port, 4747 by default): `curl -s localhost:4747/api/queue | jq '.entries[] | {key: .ticket.key, ci}'` shows `ci` on each run whose branch has run a workflow, and the card reads `CI: <n> pushes, <n> jobs, ~<n> min`. A pass is a run with a macOS job showing ten times its minutes in `ci.run.weighted`.

Consumer-declaration: none -- `tickets.ciBudgetMinutes` is a new host-file key with a default (300); no consumer repository's declaration must carry it.
