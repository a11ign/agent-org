Every round a ticket-mode run ends appends the run's outcome record to the outcome log (A11-430, step 1 of 3): each round's own tokens (a resumed round counts only the turns after the round before it ended), a batch planning run's tokens split evenly across its tickets so the shares add up to the run's, and no record when the round's transcript cannot be read, which the run's Timeline reports instead.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/outcomes/ src/ticket-mode/pool.test.ts -t "A11-430|round-tokens|outcome log|a message written once|a round counts|a batch's shares|a run's record|a transcript that is missing|a run ends on its outcome file"
```

Mutation: in `roundTokens` (`src/ticket-mode/outcomes/round-tokens.ts`) take every turn whatever `after` says, and "a run resumed for round 2 in the same session" fails (round 2 reads m1 again). Drop the remainder term from `batchShare`, and the batch test fails on its sum. In `roundEndsOf` make an unread round return a `record`, and "a run whose transcript cannot be read" fails on its empty log.

Consumer-declaration: none -- no host file key or contract changes. The outcome log is a new file in the board's state directory, read by step 2's `/api/outcomes`.
