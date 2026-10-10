The acceptance reader is handed the pull request's author and uses it for nothing (agent-org#666): `resolveAcceptanceSource` takes an optional `author`, `BodyReportInput.author` and `acceptanceSourceOfThisPullRequest(body, cwd, author?)` pass it through, and `main()` reads it from `PR_AUTHOR` through `ciInputOf` (unset or empty is `undefined`). No verdict moves. A `resolveSource` seam on `BodyReportInput` and the `thisPullRequestInput` / `ciInputOf` builders make each hand-over observable, because the reader ignores the author and no verdict shows it.

Acceptance:
```bash
cd /home/agent/repos/wt-agent-org-666 && npx rstest run --config scripts/rstest/rstest.config.ts src/acceptance-file.test.ts src/acceptance-commands.test.ts
```

The row's own command `cd /home/agent/repos/agent-org && ...` reads the primary checkout, which carries the new test only after the merge, so the command above is the same one run in this branch's tree, with `AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json` (the spawned-CLI case needs it). Printed: `VERDICT pass: 27 tests in 2 files`.

Against `origin/main`'s `src/acceptance-file.ts` and `src/acceptance-commands.ts` (swapped in from `git show`, restored from copies and diffed identical afterwards) the same command prints `VERDICT fail: 4 of 27 tests failed in 2 files`: the `PR_AUTHOR` case and the three cases that watch the author reach the reader. The verdict-unchanged cases pass on both sides by design, since the reader ignores the author and the row changes no verdict.

Mutation (each restored from a copy):
- `acceptanceSourceOf` stops passing `author` to the reader (the reviewer's mutation on #669, which the first head let through): 3 of 27 red.
- `acceptanceSourceOfThisPullRequest` stops passing `author` on: 1 of 27 red.
- `thisPullRequestInput` stops putting `author` on the input: 1 of 27 red.
- `ciInputOf` stops reading `PR_AUTHOR`: 1 of 27 red.
- `prAuthorFromEnv` returns `env.PR_AUTHOR` as is, so an empty one is `""` (first head): 1 of 24 red.
- `resolveAcceptanceSource` answers differently for `dependabot[bot]`, so the author changes a verdict (first head): 5 of 24 red.

Also run: `src/packaging/acceptance-commands.test.ts src/defect-class-line.test.ts src/public-interface.test.ts src/acceptance-file.test.ts` -- `VERDICT pass: 337 tests in 4 files`, `main` now being `runCiBodyReports(ciInputOf(process.env))`.

Typecheck: `tsc --noEmit` reports two errors, both in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` not resolvable in this tree), none in the touched files.

Assumption: the row's Region names `src/acceptance-commands.test.ts`, which did not exist (the existing file is `src/packaging/acceptance-commands.test.ts`, outside the Region), so the new cases are a new file at the named path, which the row's Acceptance command also selects.

Not in this change: the workflow side that sets `PR_AUTHOR` (its own row) and the exemption itself (agent-org#519).
