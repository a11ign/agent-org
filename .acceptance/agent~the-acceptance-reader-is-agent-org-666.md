The acceptance reader is handed the pull request's author and uses it for nothing (agent-org#666): `resolveAcceptanceSource` takes an optional `author`, `BodyReportInput.author` and `acceptanceSourceOfThisPullRequest(body, cwd, author?)` pass it through, and `main()` reads it from `PR_AUTHOR` (unset or empty is `undefined`). No verdict moves.

Acceptance:
```bash
cd /home/agent/repos/wt-agent-org-666 && npx rstest run --config scripts/rstest/rstest.config.ts src/acceptance-file.test.ts src/acceptance-commands.test.ts
```

The row's own command `cd /home/agent/repos/agent-org && ...` reads the primary checkout, which carries the new test only after the merge, so the command above is the same one run in this branch's tree, with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json` (the spawned-CLI case needs it). Printed: `VERDICT pass: 24 tests in 2 files`.

Against `origin/main`'s `src/acceptance-file.ts` and `src/acceptance-commands.ts` (swapped in from `git show`, restored from copies and diffed identical afterwards) the same command prints `VERDICT fail: 1 of 24 tests failed in 2 files`. Only the `PR_AUTHOR` case fails there, because `prAuthorFromEnv` does not exist; the verdict-unchanged cases pass on both sides by design, since the reader ignores the author and the row changes no verdict.

Mutation (each restored from a copy):
- `prAuthorFromEnv` returns `env.PR_AUTHOR` as is, so an empty one is `""`: 1 of 24 red (the `PR_AUTHOR` case).
- `resolveAcceptanceSource` answers differently for `dependabot[bot]`, so the author changes a verdict: 5 of 24 red (the reader, `acceptanceSourceOf`, `runCiBodyReports`, `acceptanceSourceOfThisPullRequest` and the CLI cases).

Typecheck: `tsc --noEmit` reports two errors, neither in `src/acceptance-file.ts`, `src/acceptance-commands.ts` or `src/acceptance-commands.test.ts`.

Assumption: the row's Region names `src/acceptance-commands.test.ts`, which did not exist (the existing file is `src/packaging/acceptance-commands.test.ts`, outside the Region), so the new cases are a new file at the named path, which the row's Acceptance command also selects. That `author` reaches `resolveAcceptanceSource` from `acceptanceSourceOf` is not observable while the reader ignores it; it is pinned by the types and by the reader's own cases, and agent-org#519 makes it observable.

Not in this change: the workflow side that sets `PR_AUTHOR` (its own row) and the exemption itself (agent-org#519).
