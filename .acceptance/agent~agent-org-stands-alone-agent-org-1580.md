The outside home of guardSweep reads the flag `outside.guards` and ships OFF (a11ign/agent-org#1580). `shadowGuardsVerdict` (`src/lib/tree-wide-guard-org-side.ts`) asks for no verdict unless the flag is a literal `true`; on, it records the org-side verdict beside the job's and `blocks` is `false`.

Acceptance:
```bash
cd /home/agent/repos/agent-org && git grep -l -F outside.guards -- src
```

Closes a11ign/agent-org#1580

Wired: `gateUnarmedOnAcceptance` (`src/work-gate/tick.ts`) reads the project's switches only when no guards switch is on, runs `shadowGuardsVerdict` over the existing guards family, reads the job's own `guardSweep` conclusion off the pull request's check rollup (`guardSweepJobOf`; absent or pending is not-compared), logs `outside-guards: SHADOW #n <kind> ... beside the job's <pass|fail|unread>: <agreement>` and hands the gate `null`, so arming is exactly as without the flag; test `(1580 d)`.

Measured at this head (earlier line superseded): `node --test src/lib/tree-wide-guard.test.ts` printed `tests 12 / pass 12 / fail 0` (five new, `(1580 a)` to `(1580 e)`); the other `src/work-gate/*.test.ts` print 2 failures that also fail without this change (measured by stashing it); `pnpm run typecheck` exits 0; `node -e "import('./src/lib/tree-wide-guard-org-side.ts')"` loads.

Mutation: each applied to `src/lib/tree-wide-guard-org-side.ts` over `tree-wide-guard.test.ts`, restored from a copy, `cmp` identical. Flag always on: 2 red. Flag never on: 3 red. `blocks` true on a fail: 1 red. The tick handing the gate the shadow verdict instead of `null`: 1 red (`d`). The tick not passing the job's verdict: 1 red (`d`).

Outside-Region: src/lib/tree-wide-guard.test.ts (the tests for the Region file); src/work-gate/tick.ts (the one caller that reads `outside.guards` and records the shadow verdict)

platform: `readSwitches` is the existing reader; the discovery and run are #1503's, reused.

Consumer-declaration: none -- the flag is absent in every declaration, so nothing changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
