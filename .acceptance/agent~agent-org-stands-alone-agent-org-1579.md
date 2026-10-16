The outside home of acceptance reads the flag `outside.acceptance` and ships OFF (a11ign/agent-org#1579). `shadowAcceptanceVerdict` (`src/acceptance-commands.ts`) runs nothing unless the flag is a literal `true`; on, it records the org-side verdict beside the job's and `blocks` is `false`.

Acceptance:
```bash
cd /home/agent/repos/agent-org && git grep -l -F outside.acceptance -- src
```

Closes a11ign/agent-org#1579

Measured at this head: `node --test src/acceptance-commands.test.ts` printed `tests 25 / pass 25 / fail 0` (five new, `(1579 a)` to `(1579 e)`); `src/packaging/acceptance-commands.test.ts`, `board-snapshot-scope.test.ts` and `no-npm-spawn.test.ts` printed `tests 345 / pass 345`; `pnpm run typecheck` exits 0. The repository has no `lint` or `verify` script.

Mutation: each applied to `src/acceptance-commands.ts` over `acceptance-commands.test.ts`, restored from a copy, `cmp` identical. Flag never on: 4 red. Flag always on: 2 red (`b`, `d`-side controls). `blocks` true on a fail: 1 red (`c`). `rowLabels` not passed on: 1 red (`e`).

Outside-Region: `src/acceptance-commands.test.ts` (the tests), `.changeset/`.

Not done: the outside run is not yet wired to a caller that reads `decisions.json` and the job's verdict; the a11ign switch row is a11ign#5613 (parked on this row). Moving the three `acceptance-*` guard tests that set `$AGENT_ORG_TOOL` is left to the row that removes the a11ign half (a11ign#5614).

platform: GitHub's `isCrossRepository` and `refs/pull/<n>/merge` are used as #1502 did; `readSwitches` is the existing reader.

Consumer-declaration: none -- the flag is absent in every declaration, so nothing changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
