`row-file` asks the decision provider (`decide`, use `duplicate-row`) whether a new row duplicates one of at most five code-chosen open rows, refuses a `same change` or `same defect` above the floor with both rows named and `--distinct-from=<n>` as the way out, warns on `one supersedes`, and takes `duplicateTitleRefusal` exactly as before when the provider is absent, keyless, switched off, refusing, timed out or under the floor.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/duplicate-row.test.ts`

Run from the repository root, with the host the environment provides (`AGENT_ORG_HOST`, which `row-file.ts` resolves at import: the suite cannot run in this tree without a project, see `ci.yml`). No checkout path is named.

Mutation: the refusal made never to fire (`verdicts.find(() => false)`) failed 3 of 15 (same change, same defect, `--distinct-from` control); made always fire (`verdicts[0]`) failed 4 of 15 (the `no` negative control, supersedes, under the floor, key missing). The use switch ignored (`return true`) failed 1 (use switched off). `duplicate-row.ts` restored byte-identical each time (`diff` against a copy).

Measured: `VERDICT pass: 15 tests in 1 file`. Full `pnpm test`: this head `VERDICT fail: 33 of 7764 tests failed in 422 files`; the same 11 failing files re-run on origin/main `9102ef3` fail the same 33 of 345, so the 33 are pre-existing and none touches this change. `tsc` reports only the two `mjs-ratchet.test.ts` errors that origin/main also has.

Closes a11ign/a11ign#4634

platform: n/a (GitHub's duplicate-issue detection is by search and cannot be asked from `row-file` over Regions; the provider seam is #4628's `decide`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
