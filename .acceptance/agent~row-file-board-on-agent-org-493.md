`row-file --board=<n>` on an `epic` boards it with Status `Backlog` and its lane label and leaves `epic` as its one state label: no `backlog` is added beside it (a11ign/agent-org#493, found on a11ign/a11ign#4505).

Acceptance:
```bash
node --import tsx --test src/row-file-board.test.ts
```

Run in this branch's tree with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json`. Printed: `pass 33`, `fail 0`.

The changed case, `#4456 ACCEPTANCE: --board= on an epic ...`, ends with labels `["epic", "out-of-release", "lane:any"]`, Status `Backlog`, and asserts `backlog` and `ready` are both absent; the success line names `epic` + `lane:any`.

Mutation:
- `isEpic ? { label: EPIC_LABEL, ... }` put back to `{ label: BACKLOG_LABEL, ... }` in `src/row-file.ts` (restored from a copy afterwards): 1 of 33 red, the case above.

Fake: the test's `gh issue edit --add-label` fake appended a label the row already had, which GitHub does not do (adding a present label is a no-op); it now skips a label already on the row, so `epic` passed as the boarding label is idempotent in the test as it is live.

Neighbours: `src/state-label-exactly-one.test.ts`, `src/board-truth-audit.test.ts` and `src/packaging/row-file.test.ts` give 248 tests with 10 failing, the same 10 with `HEAD`'s `src/row-file.ts` swapped in (this checkout resolves the home project as agent-org, so those tests expect another tracker); none is new.

Done-when 2 (a live `ceo` reading of `epic` alone on the next epic boarded through `--board=`, after the release) is not yet met.
