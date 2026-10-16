The board-truth audit calls the sibling rows of the `agent-org stands alone` epic near-duplicates of each other: the epic's rows are filed from two title templates, `agent-org stands alone (<function>): ...`, and the function is one or two words of a ~14-word title, so two siblings clear `DUPLICATE_SIMILARITY` (0.8) on words alone. `namesDifferentFunctions` (`src/board-truth-audit.ts`) makes two titles of that form that name different functions two rows, whichever second half they carry, beside `namesDifferentFlags`. A title not of the form, or two naming the same function, are still compared by words alone.

Acceptance: `node --test src/board-truth-audit.test.ts`

Mutation (the new test, `sibling rows of the agent-org stands-alone epic naming different functions are not near-duplicates (agent-org#1583)`, with a positive control that the pair `(trunk)` and `(board report)` clears 0.80 on words alone):
- before the rule: the test fails, `#5606 and #5608 are two rows for two functions` is reported as a duplicate. Measured: `ℹ tests 62`, `ℹ fail 1`.
- rule never fires (`namesDifferentFunctions` returns `false`): the new test fails, and no other.
- rule always fires on two titles of the form (the same-function check blocked too): the new test fails at its same-function assertion, `actual: [], expected: [ 5610 ]`, and no other.
- rule not wired into `nearDuplicates`: the new test fails, and no other.
- each mutant was restored from a backup and proven byte-identical with `diff`.

Measured: `node --test src/board-truth-audit.test.ts`: `ℹ tests 62`, `ℹ pass 62`, `ℹ fail 0`. `pnpm run typecheck`: exit 0. Affected suites run with the narrow command `AGENT_ORG_HOST=<host.json> pnpm exec rstest run --config scripts/rstest/rstest.config.ts <files>` over the nine files that import the audit module (`board-truth-audit*.test.ts`, `duplicate-row.test.ts`, `decision-run/classes/org-health.test.ts`, `packaging/board-prose-skips-closed-rows.test.ts`, `packaging/handoff-in-prose-is-flagged.test.ts`, `stuck-row-answered.test.ts`, `unpark-satisfied.test.ts`, `work-gate/org-health-reads.test.ts`): `VERDICT pass: 149 tests in 9 files`. The full suite (`pnpm test`) refuses to run from a standalone clone, so it was not run. No lint script exists in this repository.

Closes a11ign/agent-org#1583
