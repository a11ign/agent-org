The hand-fix ledger no longer counts a dependency bot's pull request as a hand fix (a11ign/agent-org#560, for a11ign#4623). `classifyLogin` returned `"human"` for any login in neither `ORG_LOGINS` nor `AUTOMATION_LOGINS`, and neither names a dependency bot, so every Dependabot bump was `counted`/`derived` and `hand-reroute` read as repeated. **Measured 2026-10-09 (the row, read-only):** 23 of the 30 distinct `hand-reroute` refs were `app/dependabot` PRs; the other 7 are declared `Hand-fix:` PRs and stay counted.

**What changes.**
- `classifyLogin` returns `"automation"` for a login `DEPENDENCY_BOT_LOGIN` matches, in every spelling the tool meets (`app/dependabot` as `gh pr list` writes the author, `dependabot[bot]` as the commits API writes a commit, Renovate in both). It reads the ONE definition, in the leaf `src/dependency-bot-login.ts` that a11ign/agent-org#705 moved out of `work-gate/pr-orders.ts`, so `hand-fix-ledger.ts` does not name the work gate (`failure-recorders.ts:5` keeps it out of the writer set) and there is no second hand-typed list.
- The check follows the org and automation lists and the `web-flow` case, so nothing already classified changes.
- Not in this change: whether a bump the org MERGED by hand is a hand fix (it is not; the bot opens it and the queue merges it), and the seven declared PRs.

**Evidence.** The test pins: a change authored `app/dependabot` with `dependabot[bot]` commits is `clean` (not `counted`, not `unread`), and the same for `app/renovate`/`renovate[bot]`; controls: `DanBeckDev` with the same bump title is `counted`/`derived`, `a11ign-ai-workers` with a `Hand-fix:` line is `counted`/`declared`, `not-dependabot-user` (and four other logins that merely contain a bot's name) is `human`; and a person's commit on a bot's PR is still counted for that person.

Mutation, `src/hand-fix-ledger.ts` copied aside and restored byte-identical (`diff` empty) after each:
- the bot match made never true: 2 of 17 red, both the bot tests (#560 clean, and the person-on-a-bot's-PR test, which also needs the bot recognised); the controls and the other 12 stay green.
- the bot match made always true: 9 of 17 red, including the #560 controls and the #2939 baseline.

Related files green with the host set: `hand-fix-reading-trust`, `failure-ledger`, `org-retro`, `pr-open*` (90 tests in 6 files with this one). `tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors `origin/main` has.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/hand-fix-ledger.test.ts`

Closes: none — the row's Done-when 2 (tell a11ign#4623 the fix is in force, with the merge commit) can only be true after this merges, so the row stays open until that comment is posted.

Outside-Region: .changeset/the-hand-fix-ledger-reads-a-dependency-bot-as-automation.md — the entry the `changeset-required` check asks for on a change under `src/`; CI failed without it.

platform: n/a (no GitHub, pnpm, systemd or git feature; the test takes `git` and `gh` as seams)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
