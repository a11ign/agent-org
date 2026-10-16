The outside home of the project's reports, shipped OFF behind `outside.reports` (a11ign/agent-org#1582, of "agent-org stands alone"; chairman's direction a11ign/a11ign#928). The sentence that was false and is now true: **agent-org reads a flag `outside.reports`.**

**First read** (posted on the row, comment 6214377762): CI health, token cost, weekly review and the outsider verdict had no outside equivalent (only `ci-health-liveness.ts`, which asks whether the comment arrived); the leak guard already lives in `src/lib/leak-patterns.ts`. Two of the four are HOST jobs in the project (`token-cost` reads transcripts on the host's disk; `weekly-review` needs a board credential a runner's token is not), so the workflow carries only the other two.

**The change.**
- `src/outside-reports.ts` (new): `agent-org outside-reports <name>`. The flag is read by `readSwitches`; off does nothing (no declaration read, no child). On, it runs the script the project names in `units.reports.<name>` (relative, inside the project, never a flag) with the declared arguments then the caller's. A name outside the closed set is refused; a host report is refused under GitHub Actions; an undeclared report is quiet. The exit is the script's own.
- `.github/workflows/org-reports.yml` (new): CI health Mondays (three slots) and the verdict daily, skipped while the repository variable `OUTSIDE_REPORTS_PROJECT` is unset, so no project is named in agent-org.
- `src/commands.ts`: registers the command.

**Evidence, measured at this head.** `src/outside-reports.test.ts`: 11 of 11, including the second actor in BOTH orders (home after the project's job, and the project's job after the home) leaving exactly one post, with a new period not mistaken for done. The report script in that test is a fixture that keeps the real reports' documented contract (post once per period); it proves the home adds no write of its own, not that a11ign's scripts keep the contract. Test 8 reads the flag, the declaration and the script from a real temporary checkout (`liveDeps(say, root)`, nothing injected but the directory). Tests 9-11 parse the workflow with `yaml` instead of matching its text: triggers, the gating variable, no checkout persists credentials, the token appears only in the project checkout and the last step, and the last step's shell is run with a stub `node` for each cron and dispatch to see which report it picks. `pnpm run typecheck` exits 0. `rstest run --changed=origin/main` printed `38 of 969 tests failed in 25 files`; all 38 are in `src/packaging/work-gate.test.ts` (37) and `host-install-agent-org-launcher.test.ts` (1), and the same two files print `38 of 422 tests failed` with this change's files moved aside and `commands.ts` at `origin/main`.

Acceptance:
```bash
cd /home/agent/repos/wt-agent-org-1582 && git grep -l -F outside.reports -- src
```

Closes a11ign/agent-org#1582

Mutation: seven, each applied to `src/outside-reports.ts`, restored from a copy (`diff` identical) and each red in the test that owns it. Flag always on: 1 red (the off case). Flag always off: 6 red. Host report allowed on a runner: 1 red. Host report refused everywhere: 3 red. A path that climbs out of the project allowed: 1 red. An undeclared report still run: 1 red. The script's exit swallowed: 1 red.
Review rework, four more (after the first review at `c3fd58af`): the live switch read replaced with `{}` (test 8 red, 1 of 11; before the rework the same change left 8 of 8 green), the project checkout's `persist-credentials: false` removed (test 10 red), the token added to the install step's env (test 10 red), the verdict's selection in the report step swapped (test 11 red). Each restored from a copy, `diff` identical.

Outside-Region: src/outside-reports.ts — the command the workflow runs; the row asks for the home, and a workflow alone has nothing to call.
Outside-Region: src/outside-reports.test.ts — the tests, the second actor included.
Outside-Region: src/commands.ts — registers the command.
Outside-Region: .changeset/outside-reports-home-1582.md — the entry a project that pins a tag reads.

Flag: outside.reports
Health-signals: wakes-held
Revert: set `outside.reports` to `false` (or delete it) in the project's `.agent-org/decisions.json`, or unset `OUTSIDE_REPORTS_PROJECT`; the project's own workflows and timers stay scheduled the whole time. Or revert this pull request.

Not done: (a) the project's side, which are its files and the switch row's (a11ign/a11ign#5617): `units.reports` in its `.agent-org/project.json`, the host timers for `token-cost` and `weekly-review` pointed at `agent-org outside-reports`, and the repository variable and secret (`OUTSIDE_REPORTS_PROJECT`, `OUTSIDE_REPORTS_TOKEN`). (b) The scripts' logic stays in the project; moving it here is a later row. (c) The verdict's `workflow_run`-after-release trigger has no counterpart outside the project's repository. (d) The workflow was not run, and no report was run against a live project: nothing here may reach the fleet or the lab, and the pair is tested through a fixture.

platform: GitHub's own `schedule` and repository variables (as `outside-trunk.yml`); idempotence is each report's own, kept on GitHub (the week's heading, the period's row), and nothing is kept on disk.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
