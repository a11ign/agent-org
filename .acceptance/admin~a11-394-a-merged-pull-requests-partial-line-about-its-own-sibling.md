A merged pull request's `Partial:` line that says the ticket completes when the run's own pull requests have merged is read as `Closes` once they all have (A11-394): the run's pull count is every pull request the run has, not only the outcome's, and a declaration waits while a counted sibling is open. The A11-370 shape (outcome lists one of two merged pull requests) and the A11-254 shape (`step 2 of 2 ... The ticket completes when all of them have merged`) are covered by `partial-names-own-pulls.test.ts`; a last-step line that names work (`step 2 of 2: the docs`) still asks a person.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/partial-names-own-pulls.test.ts src/ticket-mode/partial-says-nothing-remains.test.ts src/ticket-mode/pull-declaration.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/pool-blocker-cleared.test.ts
```

Consumer-declaration: none -- the board's own declaration reading; `ticket:serve` and its pool are the only consumers and change in this pull request.
