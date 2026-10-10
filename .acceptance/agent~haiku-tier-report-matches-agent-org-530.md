The Haiku trial reading builds a closing pull request's repo from `repository.owner.login` and `repository.name`, the shape `gh` returns, so the store's `gh:<owner>/<repo>#<n>:` events are found and the report counts merged pull requests instead of "0 with a merged pull request" for every row (agent-org#530).

**Cause, measured.** `gh issue list --repo a11ign/a11ign --state closed --limit 1 --label tier:haiku --json closedByPullRequestsReferences` returns `repository` with keys `id,name,owner` and `owner` with keys `id,login` (2026-10-10), no `nameWithOwner`. `closedRowOf` read `nameWithOwner ?? name`, so `repo` was the bare `a11ign`/`agent-org` and `pullEvents` (prefix `gh:a11ign/a11ign#N:`) matched nothing. The test fixtures passed a hand-made `{repo, number}` straight to `measuresOf`, never through `closedRowOf`, so no test could see it.

**What changes.** `closedRowOf` is exported and takes `nameWithOwner` where given, else `owner.login/name`; a closing pull request whose repository yields neither THROWS naming the row and the keys it saw, because `pr: null` would read as "no pull request" for every row at once, the silent zero this replaces. The test's `closedRow` now goes through `closedRowOf` on a fixture of the real shape (`{id, name, owner: {id, login}}`), so every report test reads the repo the way the live report does.

Acceptance: `cd /home/agent/repos/wt-agent-org-530 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/haiku-tier.test.ts`

Mutation: `if (repository?.name) return repository.name;` in place of the `owner.login/name` branch (the old read, for the shape `gh` returns): 5 of 13 tests red, among them the baseline and the two new ones; the restore from a copy in the scratchpad was `diff`-identical.

Measured: `haiku-tier.test.ts` passes 13 of 13. `tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors `main` has (`@a11ign/toolchain/mjs-ratchet` unresolved).

Done-when 2, measured at this head (`node src/trace/haiku-tier-report.ts` with the host, 2026-10-10T18:30Z): "n=17 closed (16 with a merged pull request)" for the Haiku rows, where it printed 0 before. `gh` names 20 `tier:haiku` rows closed since the window opened (2026-10-09T07:28:54Z), 17 of them with a closing pull request. **The report's 16 against `gh`'s 17 is NOT this defect:** the three rows the report lacks (#3215, #4180, #4343) are older than #4407, the oldest of the 300 rows `gh issue list --limit 300` returns (sorted by creation), so a row opened before that and closed in the window is not read. Filed as a11ign/agent-org#707; not folded in here.

Closes a11ign/agent-org#530

platform: n/a (a field read off the `gh` JSON that already holds it)
