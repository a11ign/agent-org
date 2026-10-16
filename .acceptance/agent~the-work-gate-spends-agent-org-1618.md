A ledger line for a gate graphql read names which read it was (`host/gh` widens the command to `api graphql <operation name, else the first selection path>`; `gh-ledger.ts` reads it into `LedgerEntry.query`, ranks it in `topQueries`/`--by-query`, and `topSpender` quotes it; a line from before still parses as the unnamed read), and an un-park refused for the tick's graphql budget is deferred for 15 minutes in a state file instead of being asked again on the next tick, while a refusal for any other reason is still an error asked again.

Change 2 (cap or reads) is NOT in this pull request: it needs an hour of named lines from the host's release first (Done-when 2 and 3), and the cap lives in `src/gh-conditional.ts`, outside this row's Region, so the Region is amended on the row before that pull request.

Acceptance:
```bash
node --test src/gh-ledger.test.ts src/unpark-satisfied.test.ts
```

Mutation: `BUDGET_REFUSAL` made to match nothing failed 3 tests (the pattern's own test, the deferral, and "no deferral given is still an error"); made to match everything failed 2 (the pattern's control and "any OTHER reason is asked again"); the `defer.hold` call removed failed the deferral test only; the wrapper's naming made never to run failed 2 (the wrapper test and `--by-query`). The wrapper's naming made to run for every call changes nothing, by construction: `graphql_query_name` prints nothing without a `query=` field, so that direction has no test and is said so. Each source restored with `cp` from a scratchpad copy and proven byte-identical with `diff`.

Consumer-declaration: none -- the ledger command field gains a suffix for `api graphql` calls only, every reader in `gh-ledger.ts` takes the old and the new line, and `unparkSatisfied`/`unparkingWaits`/`unparkOtherTrackers` gain optional parameters whose defaults keep a call that passes none as it was.
