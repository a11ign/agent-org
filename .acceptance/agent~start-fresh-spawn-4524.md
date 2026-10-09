`wake.ts` honours `startFresh: true`: a `priority:chairman` row's order, with no engineer idle, starts ONE fresh engineer (`worker-<row>`) past `MAX_SPAWNS_PER_TICK` and past the host-load refusal (`startsFresh`, pilot orders only). Still binding: the memory floor, the claim's own eligibility (B4), and an address that already holds a process, so never more than one per row. Assumption: the host-load refusal is a pace limit of the same kind as the tick allowance ("above the usual pool limit"), so it is lifted too; the orchestrator's 19:3xZ comment names it as the second cause that stopped #4588.

Mutation: `startsFresh` ALWAYS FALSE turns 3 of 9 tests red (the start at load 98, the start past the allowance, the predicate pin) and ALWAYS TRUE turns 3 of 9 red (the plain-order control at load 98, the allowance case, the predicate pin); each restore was byte-identical (`diff` of a copy).

Evidence: `wake-start-fresh.test.ts` 9/9 pass, driven through `deliver` with an empty idle pool; the file does not exist on main, so the command fails there. All 223 tests of `src/wake*` pass. `pnpm run typecheck` shows only the pre-existing `@a11ign/toolchain/mjs-ratchet` errors. Not in this PR: Done-when 2 (the a11ign `project.json` ranking) and Done-when 3 (the LIVE reading, which stays open until the journal line is quoted on the row).

Acceptance: `bash -c 'cd "$AGENT_ORG_TOOL" 2>/dev/null || cd ~/repos/agent-org; npx rstest run --config scripts/rstest/rstest.config.ts src/wake-start-fresh.test.ts'`

Closes: none -- the row stays open until Done-when 3's live reading is posted on it (#4437)

platform: n/a (spawner logic in `wake.ts`; no GitHub, pnpm, systemd or git feature starts a process past a pace limit)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
