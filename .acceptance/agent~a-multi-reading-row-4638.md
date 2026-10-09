A multi-reading row declares its schedule as `Reading: <n> at YYYY-MM-DDTHH:MM:SSZ` lines, and `waitingOn` advances the date wait to the next reading with no `Reading <n> posted` receipt on the row, so no taker hand-sets the next `Not-before:` (a11ign/a11ign#4638, class timed-reading-holds-a-worker).

- `src/reading-schedule.ts` (new, a leaf): `readingsDeclared`, `readingsPosted`, `nextNotBefore({ body, comments })`; `roundTripsUtc` moves here from `waiting-condition.ts` (which imports it) so the dependency points one way.
- `src/waiting-condition.ts`: `waitingOn` takes an optional `comments` and, when the row declares readings AND comments were supplied, uses the schedule in place of `Not-before:`. No `Reading:` line, or no comments supplied: today's `Not-before:` answer, unchanged.
- `src/reading-schedule.test.ts` (new, 16 tests).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/reading-schedule.test.ts
```

Closes: a11ign/a11ign#4638

Mutation: (one at a time, restored with `cp` and `diff`): receipts never counted (5 red), every reading counted posted (5 red), `waitingOn` ignoring the schedule (3 red), schedule used when no comments were supplied (1 red).

platform: checked whether GitHub has a scheduled-reminder or recurring-issue field; it does not, and the existing `Not-before:` field is what the gate already reads. Adds one leaf and no call.
