The outside home of guardSweep reads the flag `outside.guards` and ships OFF (a11ign/agent-org#1580). `shadowGuardsVerdict` (`src/lib/tree-wide-guard-org-side.ts`) asks for no verdict unless the flag is a literal `true`; on, it records the org-side verdict beside the job's and `blocks` is `false`.

Acceptance:
```bash
cd /home/agent/repos/agent-org && git grep -l -F outside.guards -- src
```

Closes a11ign/agent-org#1580

Measured at this head: `node --test src/lib/tree-wide-guard.test.ts` printed `tests 10 / pass 10 / fail 0` (three new, `(1580 a)` to `(1580 c)`); `pnpm run typecheck` exits 0; `node -e "import('./src/lib/tree-wide-guard-org-side.ts')"` loads.

Mutation: each applied to `src/lib/tree-wide-guard-org-side.ts` over `tree-wide-guard.test.ts`, restored from a copy, `cmp` identical. Flag always on: 2 red. Flag never on: 3 red. `blocks` true on a fail: 1 red.

Outside-Region: src/lib/tree-wide-guard.test.ts (the tests for the Region file)

platform: `readSwitches` is the existing reader; the discovery and run are #1503's, reused.

Consumer-declaration: none -- the flag is absent in every declaration, so nothing changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
