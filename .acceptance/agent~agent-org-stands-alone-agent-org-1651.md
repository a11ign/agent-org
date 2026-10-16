The CI-runnable block, limited to the two files of this change. Their skips fire wherever a11ign's tracked `packages/` tree is absent, which is the case in this repository's own CI. The row's fixture run (a temporary copy of `src/packaging/fixtures/project-tree/`, committed, with `AGENT_ORG_HOST` pointed at it) is the verbatim command recorded in the PR body, not here: `pr:open` refuses a `mktemp` wrapper. The per-file reasons and the control run are in `docs/project-tree-dependency.md`, section "The two a11ign-reader files against the fixture (agent-org#1651)".

Acceptance:
```bash
node_modules/.bin/tsc --noEmit -p tsconfig.json && node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/work-gate-a11ign-readers.test.ts src/reviewer/reviewer-recipe.test.ts
```

Measured, on this branch on top of `agent-org` `main` `ff498ea4`:
- Before the change, the row's two-file command on the fixture: `VERDICT fail: 18 of 33 tests failed in 2 files`.
- After the change, the same command on the fixture: `VERDICT pass: 15 tests in 2 files (18 skipped)`, EXIT=0.
- Control on a11ign's tree (`AGENT_ORG_HOST` pointed at a local a11ign checkout that tracks `packages/`): `skippedTests: 0`, `VERDICT fail: 11 of 33 tests failed in 2 files`. The 11 are `decide`-based, have the same messages as the fixture baseline, and are not caused by the guard, which is `false` on that tree. Their cause is not established here; they are not fixed in this change.
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` exits 0.

Not covered, named:
- The 11 failures on a11ign's tree (above). The local tree's `sessions.json` has `worker-capture` but neither `worker-5` nor `worker-2879`, which the failing assertions name; that is a lead, not a conclusion.
- The two files were not moved to a11ign. A move needs a row in a11ign's tracker, which has not been filed.

Closes: a11ign/agent-org#1651
