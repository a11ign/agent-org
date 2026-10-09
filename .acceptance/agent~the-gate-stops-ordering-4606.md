The gate no longer orders a worker to fix a red pull request whose row waits on an open native `blockedBy` edge, until the head changes or the edge closes (`withWaitingEdges` stamps the wait and the head it began at; `failingChecksOrder` asks `isWaitingRed` beside `isHeldRed`).

Evidence: `work-gate-red-pr-waiting.test.ts` 10/10 pass; the file does not exist at agent-org `e620e4c`, so the command fails there (its control). Replay of 2026-10-09 (lab#48, #49, #52 with their edges open): 30 ticks, no `pr-checks-failing` order for any, and the same three with the edges gone are three orders. Mutation of `isWaitingRed`: ALWAYS TRUE turns 7 of 10 red, ALWAYS FALSE 8 of 10; each restore was byte-identical (`diff` of a copy). The rest of the suite: 8 files fail identically on a clean `origin/main` (19 tests, all in files this diff does not touch). `pnpm run typecheck` shows only the `@a11ign/toolchain/mjs-ratchet` errors in `mjs-ratchet.test.ts`.

Acceptance: `bash -c 'cd "$AGENT_ORG_TOOL" 2>/dev/null || cd ~/repos/agent-org; npx rstest run --config scripts/rstest/rstest.config.ts src/work-gate-red-pr-waiting.test.ts'`

Closes a11ign/a11ign#4606

platform: GitHub's own native `blockedBy` edge is the wait, read from the rows the gate already holds (no new call); only the head the wait began at needed a memory, because the edge carries no time.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
