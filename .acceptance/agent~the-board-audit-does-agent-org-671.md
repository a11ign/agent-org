`nearDuplicates` in `src/board-truth-audit.ts` refuses a pair of titles that each read `Failure class <id> repeated` and carry different ids, so the #4833 (`main-red`) and #4623 (`hand-reroute`) titles are two rows, not one (a11ign/agent-org#671). Two titles of the same id are still near-duplicates and a title not of that form is compared by words alone.

Acceptance:
```bash
cd /home/agent/repos/wt-agent-org-671 && grep -q "class-repeat titles" src/board-truth-audit.test.ts && npx rstest run --config scripts/rstest/rstest.config.ts src/board-truth-audit.test.ts
```

Run in this branch's tree with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json` (without it every test in the file refuses at the project declaration). Printed: `VERDICT pass: 46 tests in 1 file`. The new test is `class-repeat titles of different failure classes are not near-duplicates (agent-org#671)`.

Against `origin/main`'s unmodified `src/board-truth-audit.ts` (swapped in from `git show`, restored from a copy and diffed identical afterwards) the same file prints `VERDICT fail: 1 of 46 tests failed`, that test, at `#4833 and #4623 are two rows for two classes` (actual `[4833]`, expected `[]`).

Mutation (measured on the final test file, each restored from a copy and diffed identical):
- the comparison replaced by `return false`, so the rule never fires: 1 of 46 red, the new test alone.
- the comparison replaced by `return true`, so it fires for every pair: 4 of 46 red, the new test and the three that pin a duplicate being found (`(6)`, `#4137`, the emptiness control), as expected of a rule that silences the whole question.
- the comparison replaced by "either title carries an id", so a title not of the form is no longer compared by words alone: 1 of 46 red, the new test alone (its one-title-has-an-id case).

Two tests in the same file failed on an unmodified checkout in this tree, `the reader: ...` and `tick: ...`: both read the AMBIENT project's declared trackers (`readBoardFacts`'s default `declaredTrackers()`), and a11ign declares a second one, so the second tracker's reads (`--repo a11ign/agent-org`) broke their "every read names `--repo a/b`" assertions. The test file is in this row's Region, so they are fixed here: `trackers: []` on the three `readBoardFacts` calls of the first and the tick test's own-repository filter. Not changed: `readBoardFacts`, `boardTruthNow`.

Typecheck: `npx tsc --noEmit -p tsconfig.json` reports no error in `src/board-truth-audit.ts` or its test; its only two errors are in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` is not resolvable in this tree), untouched here. `src/duplicate-row.test.ts`, which imports `DUPLICATE_SIMILARITY` and `namesDifferentRepos`: 15/15 pass.

Not changed, for the row that owns it: `candidatesFor` in `src/duplicate-row.ts` (the filing-time candidate list) applies `namesDifferentRepos` but not this rule, so two class-repeat titles of different ids are still offered to it as candidates (overlap over its 0.5 floor); it asks a provider rather than tripping the audit.
