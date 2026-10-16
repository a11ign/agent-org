A failure-ledger ref a person has read as NOT the class can be left out of that class's count: the index's `notOccurrences` list, read by `readLedgerRepeats` per class, the way `countedSince` already drops refs before a time (agent-org#1551)

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/class-repeat.test.ts
```

Printed: the rstest run of `src/class-repeat.test.ts`, 30 tests (25 before this change, 5 new). The five new controls are the row's (a) to (e): (a) the two false `row-not-finishable` refs listed reads 3 refs, absent reads 5 as today; (b) a ref listed under one class still counts under another that carries it; (c) a listed ref not in the ledger is no error; (d) a `notOccurrences` that is not a list of `{ref, reason}` non-empty strings makes `parseFailureClasses` return `null`, and a gate read of it is `unreadable`; (e) listing all but one ref of a class reads as no repeat. Under `node --test src/class-repeat.test.ts` in the worktree the same 30 pass, 0 fail.

Mutation:
(both directions, each run over `src/class-repeat.test.ts` and restored from a `cp` of the good copy, `diff` byte-identical after every run)
- Against `main`'s `src/class-repeat.ts` (the change reverted): 25 pass, 5 fail, all five new controls red. Control (a) fails on `main`, as the row requires.
- The exclusion never fires (`!notOccurrence.has` replaced by `true ||`): 4 red, (a), (b), (c) and (e); (d) stays green, since it tests parsing and not the count.
- The exclusion ignores the class (the key becomes the ref alone): 1 red, (b), the per-class control.
- A malformed `notOccurrences` is accepted (`wellFormed` replaced by `true ||`): 1 red, (d).
- The exclusion always fires (`!notOccurrence.has` replaced by `false &&`): 6 red, the new controls and two existing `countedSince` cases among them.

Consumer-declaration: none -- `notOccurrences` is optional and absent in every index on disk, so every current reading is unchanged; the `.agent-org/failure-classes.json` of a11ign is not edited here (the row names it as `ceo`'s edit after this merges, and the old parser ignores the unknown key).
