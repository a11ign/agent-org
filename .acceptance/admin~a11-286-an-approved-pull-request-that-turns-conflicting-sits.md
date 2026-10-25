Closes A11-286

Every open pull request the board opened for a ticket is watched whatever its run's phase: found from the run log (`src/ticket-mode/kept-pulls.ts`), read on the feedback cadence (`watchKeptPulls` in `src/ticket-mode/pool-base-merge.ts`), and listed in the `pulls` map. A pull request that turns `CONFLICTING`/`DIRTY`, or `BEHIND` (code host contract 1.24, `PullFeedback.behind`), is merged up to date by the host's `updateBranch` first; a conflict the host reports as real starts a conflict round that names the files, the base and the merge command, ahead of the ticket's next step, which waits in `Entry.afterRound` until the round has pushed. The card says "<pull request> conflicts with main: merging main in" or "conflict round started".

Acceptance:
```bash
# A conflicting pull request of a queued next-step ticket starts a conflict round (real git for the files), update-branch clears a behind or trivially conflicting one with no round, a new head is tried again, a running, stacked or merge-queued run is left alone, a refusal is tried again, the cap queues no round.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-base-merge.test.ts src/ticket-mode/kept-pulls.test.ts src/ticket-mode/pool-outcome.test.ts
# Behind reads as behind, and the earlier conflict-round tests as they were.
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/pull-feedback.test.ts src/ticket-mode/pool-restack-order.test.ts src/ticket-mode/pool.test.ts
npm run typecheck
npm run lint
# The card's words.
pnpm --dir ui exec rstest run --config rstest.config.ts src/run-detail/run-detail-timeline.test.tsx
```
Run the rstest lines with `AGENT_ORG_HOST` naming a host declaration, as CI's `suite` job does (the fixture project copied to a temporary directory).

After merge: the next approved pull request that goes conflicting is merged up to date or gets a conflict round with no person. Read the run's card: its Timeline shows "conflicts with main: merging main in" or "conflict round started" for that pull request, with no person's action before it.
