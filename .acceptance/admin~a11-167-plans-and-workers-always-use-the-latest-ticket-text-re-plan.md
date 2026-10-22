## What it is

A ticket's text can change after it is queued or planned (A11-166 gained a replay method and a cookie-dialog rule while it waited), and nothing guaranteed that the plan and the worker used the latest text, or that a dependent learned what its blockers' pull requests found. This change stamps an attached plan with the `updatedAt` and description hash it was planned against, plans again before the worker starts when the description changes, sends a change to a running worker, carries the text and its `updatedAt` in every brief, and gives a dependent's planner what its blockers' merged pull requests found.

## Change

- `ticket-read.ts`, `plan-stamp.ts`: the ticket read (`updatedAt`, sha256 of the description, text) and the `## Planned against` stamp the board writes before a plan's `## Paths`.
- `pool-ticket-text.ts`, `pool-tracker.ts`, `pool-start.ts`, `pool-settle.ts`, `pool-prepare.ts`: the batched check of every queued and running ticket on each refresh, the stale mark, the re-plan (copy, detach, plan again), the message to a running worker, the findings of merged blocker pull requests, and the refusal of a plan that does not say how each applies.
- `worker-files.ts`, `brief-ticket-text.ts`: every brief says when the text was read and when it was last updated; the review round carries the description and what changed; the planning brief carries the findings and the re-plan section.
- `board-view/ticket-change.ts`, `board-view/run-reason.ts`, `ui.html`, `server.ts`: the run lines, the "What changed" dialog and the "learns from" links.
- `src/plugins/contracts/tracker.ts` (1.3: `updatedAt`, `texts`, `detachPlan`), `src/plugins/contracts/code-host.ts` (1.4: `readMergedFindings`), `plugins/linear/`, `plugins/github/merged-findings.ts`, the fakes and the conformance suites.

## How it is proven

Each acceptance line of the ticket is proven by a named test: the planning brief and the stamp (`the planning brief carries the ticket as the tracker has it at start`, `an attached plan is stamped with the updatedAt and description hash`), the re-plan (`a ticket edited after planning is re-planned before its worker starts`, `a re-plan detaches the stale plan`, `an unstamped plan is never marked stale`), the live worker (`a description change while a worker runs is prompted to it`), the blockers' lessons (`a blocker's merged findings appear in the dependent's planning brief`, `a dependent planned before its blocker merged is re-planned`, `a plan given blocker findings without a What the blockers found section`), and the brief (`the worker brief and the review-round brief carry the ticket text as read at start`).

Acceptance:
```bash
set -e
npm run lint
npm run typecheck
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ticket-read.test.ts src/ticket-mode/plan-stamp.test.ts src/ticket-mode/worker-files.test.ts src/ticket-mode/board-view.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/server.test.ts plugins/linear plugins/github src/plugins
```

History: full

`pool.test.ts` imports the pool, whose import closure reads `git log` (the host-drift notes), so this run needs the full history the checkout would otherwise lack.

Mutation: fourteen changes were made in turn, and each time one or more of the new tests went red; all were restored and the suites passed again. They were: no re-plan of a stale plan; no stamp written; no stale mark; no message to a running worker; no learning from a blocker's merged pull request; no refusal of a plan that leaves a finding out; no re-plan for findings that reached a plan after it was written; no read line in a brief; a stale mark that never clears; no changed-since-last-round section; no description-hash comparison; a re-plan that detaches a file the stamp does not list; no "Worked against" line; and a stamp read back without the pull requests its plan names.

Consumer-declaration: none -- the new entry fields (`briefedAgainst`, `plannedAgainst`, `plannedWith`, `previousPlan`, `ticketChange`, `ticketChanges`, `learned`, `findingsGiven`) are read only by the pool, the server and the page, and a queue file written before them has none and reads as before. The tracker (1.3) and code host (1.4) additions are optional.
