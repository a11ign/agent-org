`foreignRedsOf` (`src/ticket-mode/pool-foreign-checks.ts`) no longer counts a check as red elsewhere because other runs' pull requests fail it when main reports that check passing, and `heldCheckOf` (`src/ticket-mode/pool-checks.ts`) drops an owner named in the error lines once the board holds that ticket as settled, including one recorded at an earlier watch, so the check gets a round or the board's fix ticket instead of a hold that never ends.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-checks.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/main-red
```

Mutation: make the `elsewhere` filter in `foreignRedsOf` keep every check, and the "main reports passing" A11-429 test fails with `not-ours`; make `liveOwner` return the named ticket always, and the "settled owner" A11-429 test fails with `A11-127`.

Consumer-declaration: none -- no host file key or contract changes. The board holds fewer pull requests: one whose check main passes gets its round, and one held under a settled ticket gets the fix ticket A11-428 already files.
