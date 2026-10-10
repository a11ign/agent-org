Closes a11ign/agent-org#659

## Change

`.github/workflows/ci.yml`, the step "Put this checkout's tool where the tool lives in a project, and the tests' siblings beside the tests" (line 100):

```diff
-          cp -r src host scripts .github CHANGELOG.md package.json LICENSE README.md project/packages/agent-org/
+          cp -r src host scripts docs .github CHANGELOG.md package.json LICENSE README.md project/packages/agent-org/
```

Acceptance:

```bash
cd /home/agent/repos/wt-agent-org-659 && grep -E 'cp -r [^|]*\bdocs\b[^|]* project/packages/agent-org/' .github/workflows/ci.yml
```

Measured: it prints `          cp -r src host scripts docs .github CHANGELOG.md package.json LICENSE README.md project/packages/agent-org/` and exits 0; on main it exits 1.

## Does any existing test read a file the new copy makes present?

**Yes, one test passed only because `docs/` was absent, and this PR changes it.**

`src/packaging/project-roles.test.ts`, "no `.md` role brief lives under `packages/agent-org/src` or `packages/agent-org/docs`", walks `HOME_CHECKOUT/packages/agent-org/docs` and asserts it holds no `.md`. In the gate `HOME_CHECKOUT` is `project/`, so with `docs/` copied it finds `docs/messaging.md` and fails. Measured in a hand-built copy of the gate's layout (`project/.agent-org` from a11ign, this checkout's tool at `project/packages/agent-org`, `git init`), before and after:

- unchanged test: 18 of 19 pass; the walk test fails with `the tool ships no brief under packages/agent-org/docs: …/docs/messaging.md`.
- with the edit in this PR: 19 of 19 pass.

`docs/messaging.md` is the tool's own document, not a role brief. The test now names a brief the way the project does: a `.md` whose name a file in the declared roles directory (`homeRolesDir()`) also has. A real brief copied under `docs/` still fails it.

The row said "no test changes meaning" and "nothing else in the workflow changes"; the workflow change is that one word, and the test edit is the consequence the row did not foresee.

## What I did not do

- I did not run the full gate or the whole suite in that layout. I ran `project-roles.test.ts` there and searched the tests for other readers of `docs/`: the other `docs/…` matches are string fixtures, scratch-project `mkdir`s (`sweep-window`, `claimed-region-overlap`, `row-claim-*-chairman-yield`, `work-gate-closed-pr-branch`) or read `HOME_CHECKOUT/docs/…` (the project's `docs/`, not the tool's: `board-gate-source`, `standalone-roots`, `public-claim`), so the new copy does not reach them. `ci.yml` is a workflows Region: review is `ceo`'s.
- `.agent-org/roles/engineer.md`, which my brief told me to read, is not in this repository or its main clone (the roles directory is the project's, a11ign/a11ign), so I worked from the row alone.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
