`ownerOfPr` has a `dependency-bot` rung: a pull request opened by Dependabot or Renovate is owned by `ceo` BY NAME (source `dependency-bot`), so the `owner-unresolved` recorder (keyed on the `ceo` source) and the resolver-defect flag no longer see it.

Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4624 && AGENT_ORG_HOST=/home/agent/repos/wt-4624/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/pr-owner-dependency-bot.test.ts'`

Mutation: the rung made never to fire (`if (false && isDependencyBotPr(pr))`) failed 2 of 5 (the ladder names the bot's PR; the order's words); the rung made always fire (`if (true)`) failed 1 of 5 (POSITIVE CONTROL: a person's unowned PR still reaches `ceo` and is recorded). `pr-orders.ts` restored byte-identical each time (`diff` against a copy).

Measured: `VERDICT pass: 5 tests in 1 file`. Full suite at this head: `VERDICT fail: 33 of 7677 tests failed in 416 files`; the 11 failing files re-run with `pr-orders.ts` reverted: `VERDICT fail: 33 of 345 tests failed in 11 files`, the same 33 (pre-existing, none touches the ladder).

Closes a11ign/a11ign#4624

platform: n/a (a rung in the owner ladder; GitHub names the author, which is what the rung reads)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
