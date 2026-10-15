A `lane:orchestrator` row labelled `fleet-gated`, or whose Acceptance or body names a fleet or lab command, keeps the gate's standing `orchestrator` order when `workers.orchestratorOneShot` is ON; a plain row is still converted; a row whose body cannot be read, or an order handed no reader, keeps the gate's order. `withOrchestratorOneShot` in `src/orchestrator-one-shot.ts` decides it through `fleetOrLabAcceptance` in `src/acceptance-commands.ts`. The flag OFF path is unchanged and returns the same array.

Acceptance: `node --test src/orchestrator-one-shot.test.ts`

Mutation: `admits` made always true (`return true;`) failed the two fleet-or-lab tests, matching `main`'s behaviour; `admits` made always false (`return false;`) failed the plain-row conversion controls; the `fleet-gated` label check removed failed the fleet-gated-label test alone. Each mutated file was restored byte-identical (`cp` from a scratchpad backup, then `diff`).

Measured: `node --test src/orchestrator-one-shot.test.ts` gives `pass 13, fail 0`; `pnpm run typecheck` exits 0.

Closes a11ign/agent-org#1527

🤖 Generated with [Claude Code](https://claude.com/claude-code)
