The four Region files in `src/packaging/` pass against the fixture project, or skip by name where the project lacks the data they read, and nothing about a11ign is hard-coded: a file that needs data the project lacks skips by name, and runs whole wherever that data exists. `board-gate-source.test.ts` skips its six tests when the project's `docs/board/reported/gates/` holds none of the recorded gates; `worktree-owner.test.ts`'s `#1128: a stamped worktree still reads CLEAN` skips when the project has no `.gitignore`, since the test checks that the project's own ignore rule hides the stamp; `standalone-roots.test.ts` writes the causes plugin only when `project.json` declares `causes`, and reads the in-tree owned-path expectation from `docs/owned-path-facts.json` when that file exists (null when it does not, so the check is weaker in the fixture). `region-paths-checkout.test.ts` needed no change and passes.

Acceptance:
```bash
node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts src/packaging/worktree-owner.test.ts src/packaging/standalone-roots.test.ts src/packaging/board-gate-source.test.ts src/packaging/region-paths-checkout.test.ts
```

Measured in the CI-runnable form, on this branch: `VERDICT pass: 39 tests in 4 files`, exit 0, no skips (the project's own gate records and `.gitignore` are present).

Measured on the fixture (the row's form: a committed copy of `src/packaging/fixtures/project-tree/` with `AGENT_ORG_HOST` pointed at it, recorded in the PR body and not here, because `pr:open` refuses a `mktemp` wrapper in the Acceptance block): `VERDICT pass: 32 tests in 4 files (7 skipped)`, exit 0, no failures. The seven skips are the six `board-gate-source.test.ts` tests and the `#1128` CLEAN test in `worktree-owner.test.ts`. Before the change, three of the four files failed on the fixture: `board-gate-source` died on ENOENT reading the gate records at module load, `standalone-roots` died on ENOENT reading `docs/owned-path-facts.json` at module load, and `worktree-owner`'s CLEAN test read `?? .a11y-owner` because the fixture has no `.gitignore`.

Mutation: the fixture copy with the gate records and facts file added and a `.gitignore` containing `node_modules` in place of `.a11y-owner` fails `#1128: a stamped worktree still reads CLEAN` (1 of 39), and nothing else; the stamp-ignore check is the one that catches the break.

Typecheck: `pnpm run typecheck` exits 0. There is no lint script in this package. The full `pnpm run test` refuses to run from a clone (`node scripts/test-entry.ts`: the suite needs a laid project), so the changed set above is the local run; CI's suite job runs the whole suite from a laid project.

Not here, and named: the fixture's missing `.gitignore` and gate records are the reason the skips exist; giving the fixture its own `.gitignore` and records would lift them, and that is a fixture change outside this Region. The a11ign-side home of the board gate test is not filed as a row in this PR.

Closes: a11ign/agent-org#1652

🤖 Generated with [Claude Code](https://claude.com/claude-code)
