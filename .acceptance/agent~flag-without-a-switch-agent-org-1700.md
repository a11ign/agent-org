A refused owed-rows read names its cause. `liveOwedRows` (`src/flag-switch-ledger.ts`) kept no reason for a refused read: its catch returned a bare `null`, so the flag-without-a-switch line could only say the rows "could not be read". The catch now returns the first line of the thrown error as `{ refused }`, and `owedRowsOf` puts it in the `unknown`. The test pins that the `unknown` contains the thrown message's first line, with a negative control: a list that returns no rows yields no `unknown`.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/flag-switch-ledger.test.ts`

Mutation: the `unknown` made to drop the cause (`could not be read (${listed.refused}), so` changed to `could not be read, so`) fails the new test "a refused owed-rows read names its cause (agent-org#1700)" and no other of the 25; the file restored byte-identical (`cp` to a scratchpad copy, then `diff`).

Consumer-declaration: none -- the change is inside the flag ledger the tick reads; the other trackers' rows keep their existing `unknown` shape, and no test asserted the old text (`git grep`).
