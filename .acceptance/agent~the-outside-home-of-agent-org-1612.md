With `outside.acceptance` on and `A11IGN_PR_ACCEPTANCE_BY_GATE` off, the work gate now runs the acceptance shadow: each eligible pull request has its acceptance verdict computed by `shadowAcceptanceVerdict` (`src/acceptance-commands.ts`), recorded and logged as `outside-acceptance: SHADOW #n <kind> (<why>) beside the job's <pass|fail|unread>: <agreement>; blocks nothing.`, and the gate is handed `null`, so nothing is held back. The job's verdict is read from the newest `acceptance` check run (`acceptanceJobOf` in `src/work-gate/tick.ts`); when there is none the job reads `unread` and agreement is `not-compared`. With the flag absent or false, the output and calls are byte-identical to before (a test pins both). Non-eligible pull requests are unchanged. Guard shadows and acceptance shadows may both be on, each on its own line.

The shadow runs beside the real gates, which always decide through `firstRefusalOf`. This also fixes a pre-existing fault: with `outside.guards` on, `gateUnarmedOnAcceptance` skipped the real acceptance gate. Test `(1579 viii)` pins it.

The row's Region is `src/work-gate/tick.ts` and `src/work-gate/outside-acceptance-shadow.test.ts`. Outside it: `src/acceptance-commands.ts` (`shadowAcceptanceVerdict` takes an optional `verdictOf` seam so the gate can supply its own verdict; the default is unchanged). Also `src/acceptance-commands.test.ts` and `src/lib/tree-wide-guard.test.ts`, each given `outsideSwitches: () => ({})` so the tests do not read the host's `decisions.json` (which carries `outside.acceptance: true` from a11ign#5613).

Measured: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --test src/work-gate/outside-acceptance-shadow.test.ts src/acceptance-commands.test.ts src/lib/tree-wide-guard.test.ts` prints `ℹ tests 47`, `ℹ pass 47`, `ℹ fail 0`. `pnpm run typecheck` exits 0. Mutations on copies: removing the shadow call fails 6 tests; the verdict ignoring the flag fails `(1579 b)` and `(1579 vii)`; a guard shadow returning early (the pre-existing fault) fails `(1579 viii)` and `(1579 ix)`.

Split out: done-when 3 (the first `outside-acceptance: SHADOW #n` line from the host's gate, quoted on a11ign#5613) is its own row, a11ign/agent-org#1646, because it needs the host and cannot be run from this worktree; this PR does not claim it. The Acceptance command as written runs in `~/repos/agent-org`, which is a different checkout without this change, so there the new file is absent and only the 25 `acceptance-commands` tests run.

Acceptance:

```bash
cd ~/repos/agent-org && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --test src/work-gate/outside-acceptance-shadow.test.ts src/acceptance-commands.test.ts
```

Closes a11ign/agent-org#1612

🤖 Generated with [Claude Code](https://claude.com/claude-code)
