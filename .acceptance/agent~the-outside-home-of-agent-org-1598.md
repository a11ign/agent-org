The outside home of the `ownedPaths` job reads the flag `outside.ownedPaths` and ships OFF (a11ign/agent-org#1598). `shadowOwnedPathsVerdict` (`src/owned-path-signoff.ts`) asks for no verdict unless the flag is a literal `true`; on, it records the org-side sign-off verdict of an AGENT pull request beside the job's and `blocks` is `false`. An outside pull request is `not-run` before the facts file is read.

Acceptance:
```bash
cd /home/agent/repos/agent-org && git grep -l -F outside.ownedPaths -- src
```

Closes a11ign/agent-org#1598

Wired: `gateUnarmedOnAcceptance` (`src/work-gate/tick.ts`) reads the project's switches, and for each ELIGIBLE (same-repository `agent/*`, declared identity) unarmed pull request runs `ownedPathsVerdict` over the payload's `files` and `body` (no checkout), reads the job's `ownedPaths` conclusion off the check rollup (`ownedPathsJobOf`; absent, skipped or pending is not-compared), and logs `outside-ownedpaths: SHADOW #n <kind> ... beside the job's <pass|fail|unread>: <agreement>`. It is not a family of the gate: it returns nothing to `acceptanceGateOf`, so arming is exactly as without the flag. Tests `(1598 a)` to `(1598 h)` in `src/owned-path-signoff-outside.test.ts`.

Measured at this head: `node --test src/owned-path-signoff-outside.test.ts` printed `tests 8 / pass 8 / fail 0`; `pnpm run typecheck` exits 0; `node -e "import('./src/owned-path-signoff.ts')"` loads. The 21 test files that import the tick, the sign-off or the guard side print `tests 1005 / fail 37` with this change and the same 37 failures (names compared, `comm -23` empty) at the unmodified base commit, measured in a detached worktree. `pnpm test` cannot run from this clone (it says so: not a laid project), so the whole suite was not run.

Mutation: each applied to the source, run over `src/owned-path-signoff-outside.test.ts`, restored from a copy and `diff`ed identical. Flag always on: 3 red (a, e, g). Flag never on: 3 red (a, e, g). Eligibility skipped in `ownedPathsVerdict` (an outside pull request is asked): 1 red (d). Tick records the shadow before the eligibility check: 1 red (g). Tick hands the gate the shadow verdict (blocks): 1 red (g). Job name wrong in `ownedPathsJobOf`: 2 red (f, g).

Outside-Region: src/work-gate/tick.ts (the one caller that reads `outside.guards` today and so records the shadow verdict, as #1580 did); src/owned-path-signoff-outside.test.ts (the tests for the Region file)

platform: `readSwitches` is the existing reader; `signoffVerdict` and `loadFacts` are the job's own, reused. The open-pull-request payload already carries `files`, `changedFiles` and `body`, so no `git diff` is run.

Consumer-declaration: none -- the flag is absent in every declaration, so nothing changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
