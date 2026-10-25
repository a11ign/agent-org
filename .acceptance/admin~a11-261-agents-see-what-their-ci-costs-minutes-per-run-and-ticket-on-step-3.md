# A11-261, step 3 of 3: the card shows over-budget in amber

A run's card draws its CI line (`CI: 3 pushes, 48 jobs, ~184 min`) in an element of its own, `.run-ci`, under the note, no longer joined into the note. It is plain while the ticket is under its budget and takes the existing warn tone (`tone-warn`, `--color-warn-text`) once the ticket is over budget (`ci.state` `over`) or the run is held at twice it (`held`); no new token. `ciLineOf` (`ui/src/runs/runs-model.ts`) gives the card the line and its tone; `noteLines` still carries the line, so Run detail lists it as before, and `noteOf` leaves it out. This is the last step: with it the ticket's Acceptance is met.

Acceptance:

```bash
# ci-line.test.tsx: the line plain under budget, tone-warn over it and when held, absent without a CI read, and not repeated in the note
pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/ci-line.test.tsx src/runs/runs-model.test.ts
pnpm ui:typecheck
```

After merge, the chairman session sees it on the live board: a run whose ticket is over `tickets.ciBudgetMinutes` shows its CI line in amber on the Runs page.
