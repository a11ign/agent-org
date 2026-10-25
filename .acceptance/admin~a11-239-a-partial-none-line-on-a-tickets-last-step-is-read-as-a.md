## What it is

A `Partial:` line that says nothing remains (`none`, `nothing`, `n/a`, `last step`, `nothing remains` and the like, in any case) is the last step, which closes the ticket (A11-239). `pr:open`'s `closes` report and CI's refuse it and tell the worker to write the closing keyword and the key and no `Partial:` line. The board reads such a line in a merged pull request as `Closes`, so the merge backstop completes the ticket, a blocked run stops waiting on it, and the card shows no partial merge. An outcome `partial` whose own words say nothing remains is no disagreement with a `Closes` body.

## What it checks

`src/ticket-mode/partial-says-nothing-remains.test.ts`: each wording is refused by `ticketClosesReport` and `namedTicketClosesReport` beside `Refs` and beside `Closes`; real remainders (`none of the UI yet; ...`, `the last step's screenshots remain`) are still accepted; `declarationOf` and `declaredByBlockerPull` read the wordings as `closes`; a pool test with agent-org#1877's body completes the ticket with no next step, no put-back and no partial merge on the card. The worker brief's sentence that the last step of a stepped ticket names `Closes <KEY>` with no `Partial:` line is asserted by `src/ticket-mode/worker-files.test.ts` (A11-168).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/partial-says-nothing-remains.test.ts src/ticket-mode/pull-declaration.test.ts src/packaging/ci-closes-report-reads-a-ticket.test.ts src/ticket-mode/worker-files.test.ts
```

Consumer-declaration: none -- no option of a project declaration is added.
