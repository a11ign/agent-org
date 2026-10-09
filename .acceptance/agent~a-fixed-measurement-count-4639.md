A fixed measurement (`count X at time T`) is a scheduled script that posts the number on its row: `takeDueReading` runs a row's allowlisted `Reading-script:` when its next `Reading: <n> at T` is due and posts `Reading <n> posted` + `Reading <n>: <value> (<command>, <timestamp>)`, refusing any script off the allowlist with the reason (a11ign/a11ign#4639, class timed-reading-holds-a-worker; first candidate #3870's `git worktree list | wc -l`).

- `src/scheduled-reading.ts` (new, a leaf over `reading-schedule.ts`): `takeDueReading`, `judgeExpectation`, `readingComment`, `ALLOWED_COMMANDS`. No shell: the allowlist maps the declared command to a function that spawns `git` with an argument vector and counts lines itself.
- `src/scheduled-reading.test.ts` (new, 14 tests; one spawns real `git` in a throwaway directory as the control for the default runner).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/scheduled-reading.test.ts
```

Closes: a11ign/a11ign#4639

Mutation: (one at a time, restored with `cp` and `diff`): allowlist always passes (1 red: the outsiders test), allowlist never passes (9 red), reading never due (8 red), reading always due (2 red), receipt line dropped from the comment (3 red), checkout name unchecked (1 red), a failed script posts anyway (1 red).

platform: checked whether GitHub has a scheduled-workflow or recurring-issue-comment feature that could post a count onto a row; Actions `schedule:` could run `git worktree list`, but not on the agents host's checkouts and not against the row's `Reading:` receipts the gate already reads. Adds one leaf and no call.
