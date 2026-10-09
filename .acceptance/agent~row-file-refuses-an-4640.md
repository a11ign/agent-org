`row-file` refuses a Done-when item that names a future time, a seat's or the chairman's act, or another row's outcome, unless that wait is already data on the row, and the refusal offers the split (the second row's Done-when and the `Not-before:` / owner label / `--blocked-by` it carries). `src/unsplit-done-when.test.ts` pins every class with its negative controls (the wait carried as data; the row, seat or date only cited; the row's own Done-when) and drives `createIssue` to show the check is wired in and nothing is filed.

Evidence (measured on this branch): the six tests pass. Mutations, each breaking only its own tests: the classifier never fires (cases 1 and 6 fail), data never excuses a wait (case 2 fails), a bare `#n` counts as a row's outcome (case 3 fails), and the call removed from `createIssue` (case 6 fails); each file restored byte-identical. `row-file` run for real on three fixture bodies refused each with the split offered (exit 1, nothing filed), and on the split version filed a11ign/a11ign#4643 as `backlog` with `out-of-release`, closed straight after as not planned. The 9 failures in `src/packaging/row-file*.test.ts` read the same on an unmodified checkout.

Acceptance: `cd ~/repos/agent-org && npx rstest run --config scripts/rstest/rstest.config.ts src/unsplit-done-when.test.ts`

Closes a11ign/a11ign#4640

platform: n/a (a filing refusal over the row body; GitHub has no notion of a Done-when)
