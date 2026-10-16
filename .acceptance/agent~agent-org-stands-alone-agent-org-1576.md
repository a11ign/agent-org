`agent-org outside-trunk` is the outside home of a project's trunk jobs (the close-rows sweep, `trunk-revert-guard`, `workflow:liveness`, `board:liveness`), behind `outside.trunk` in the project's `.agent-org/decisions.json`. The sentence that was false and is now true: **agent-org reads a flag `outside.trunk`.** It ships OFF: absent, `false` and a non-boolean all do nothing at all (no state read, no git, no child).

**The first read** (what exists outside the project's `trunk.yml` for each command) is on the row: the sweep, the revert guard and both liveness checks had none and are built here; `parent-recheck-summary` already has its equivalent (`trunk-red.ts`, `work-gate/causes/pr-ejected.ts` call its `summarizeTestLog`), so nothing is built for it.

**The change.**
- `src/outside-trunk.ts` (new): reads the flag with the same reader as `routing.haikuDefault`, then runs the project's five scripts as children in the project's checkout, per new first-parent commit of `origin/main` for the commit checks. A commit is marked answered only when every one of its checks gave a verdict (exit 0 or 1; 2 and a timeout are asked again), so a second actor does nothing per commit. The sweep is the job's own and closes by `closurePlan`, which reports a closed row as `already`.
- `src/work-gate/route-outcome-pass.ts`: `recordRouteOutcomesOnHost` calls `outsideTrunkOnHost(switches)` with the switches it already read: off costs nothing, on is paced to once per 10 minutes.
- `.github/workflows/outside-trunk.yml` (new): hourly, and skipped while the repository variable `OUTSIDE_TRUNK_PROJECT` is unset, so no project is named in agent-org.

**Evidence, measured at this head.**
- `src/outside-trunk.test.ts`: 11 of 11, with the real `closeOnePr` over a fake `gh` that remembers its closes (the first actor closes the row, the second finds it closed and closes nothing).
- `src/work-gate/route-outcome-pass.test.ts` and `src/packaging/work-gate-source.test.ts` pass with the call added. `src/packaging` has 76 failing tests of 5503 on a clean `origin/main` worktree in this clone; the same directory with this change had 77, and the one extra was this change's wiring test reading `route-outcome-pass.ts` directly, which `work-gate-source.test.ts` refuses; it now reads through `workGateSource()`. The 76 are not caused by this change and were not investigated here.
- `pnpm run typecheck` exits 0. `node -e "import('./src/outside-trunk.ts')"` imports. The repository has no `lint` script.

Mutation, each applied to `src/outside-trunk.ts` in place with a `cp` backup restored and checked with `diff`:
- `outsideTrunkOn` always true: 1 red (case 1, off is off).
- `outsideTrunkOn` always false: 7 red (cases 1, 2, 3, 5, 6, 7, 8), the cases that need it on.
- the answered commits never remembered: 2 red (cases 3 and 7).
- a could-not-ask commit marked answered: 1 red (case 6).
- the pacing never applied: 1 red (case 5).

**Not shown.** The home was not run against a live project: nothing here may reach the fleet or the lab, and the children are covered by injected checks and by a test that each script they name exists and is a registered command. The workflow was not run (it needs the `OUTSIDE_TRUNK_PROJECT` variable and `OUTSIDE_TRUNK_TOKEN`, which the switch row's owner sets). The canary comparison with the project's jobs is the 7-day window on the row.

Acceptance: `git grep -l -F outside.trunk -- src && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/outside-trunk.test.ts`

Closes a11ign/agent-org#1576

Flag: outside.trunk
Health-signals: blind-ticks, wakes-held
Revert: set `outside.trunk` to `false` in the project's `.agent-org/decisions.json` (or unset `OUTSIDE_TRUNK_PROJECT`); the project's jobs run either way.

Outside-Region: src/outside-trunk.ts — the home itself; the row's Region lists the existing files it calls and the gate path, and the flag has to be read in a new module.
Outside-Region: src/outside-trunk.test.ts — its tests.
Outside-Region: src/commands.ts — registers the `outside-trunk` command.
Outside-Region: .github/workflows/outside-trunk.yml — the scheduled half of the home.
Outside-Region: .changeset/agent-org-stands-alone-trunk-outside-home.md — the entry a project that pins a tag reads.

platform: GitHub's `schedule` and a repository variable gate the workflow, `actions/checkout` lays the project; the scripts themselves are the org's, run from its side (no GitHub feature closes a row for a bot merge, which is why `close-rows-sweep` exists).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
