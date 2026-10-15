Below the reserve, a paced tick skips `orgHealth` first and keeps reading the other repositories until the floor. Before, the reserve skipped `orgHealth` and the other repositories' lanes together, so a settled-green pull request in another repository got no reviewer order for ~20 minutes each hour. Now `GRAPHQL_RESERVE` (1000) gates `orgHealth` only, and a new `GRAPHQL_FLOOR` (500, named with its reason beside it) gates the other repositories' lanes below it. `Pacing` carries `belowFloor` beside `paced`, and `src/work-gate.ts` keys the other repositories' reads and the event-unread check off `belowFloor`. A skipped lane is still reported unread, never clean.

The floor value is a judgement (half the reserve), not a measurement of what one tick's reads cost.

Acceptance:

```bash
cd /home/agent/repos/wt-agent-org-1417 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --test src/packaging/gate-graphql-pacing.test.ts
```

Needs `AGENT_ORG_HOST` set in the shell, as on `origin/main`: the test's import chain reaches `src/project-config.ts`, which refuses to load without it. Measured with `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json`. The command itself is unchanged.

Closes a11ign/agent-org#1417

Pinned by `src/packaging/gate-graphql-pacing.test.ts`: the three bands (above the reserve, between the reserve and the floor, below the floor), each with boundary values (reserve, reserve−1, floor, floor+1, floor−1), and a wiring test that reads `src/work-gate.ts` through `workGateSource()` and asserts the `belowFloor` keys. The red control is in the band test.

Mutation, each file backed up to the scratchpad with `cp`, changed, run, restored with `cp`, and diffed byte-identical (measured before the rebase onto `origin/main`; my four files are unchanged by it):
- A: `GRAPHQL_FLOOR = GRAPHQL_RESERVE` (the old order): 2 red, including the band test.
- B: `src/work-gate.ts` event-unread check keyed on `pacing.paced` instead of `pacing.belowFloor`: 1 red, the wiring test.

Measured on the rebased branch (`7d562fa3`):
- Acceptance, with `AGENT_ORG_HOST` set: `ℹ tests 27`, `ℹ pass 27`, `ℹ fail 0`.
- `pnpm run typecheck` exits 0.
- Related suites: `machinery-canary` 28/28, `work-gate-size` 4/4, `work-gate-source` 6/6.
- The 26 files that fail under `node --test` in this worktree were run on a `git archive` of the pre-rebase HEAD: the same pass/fail counts with and without the change. `queue-stalled.test.ts`'s `#3019` failures predate the change too. `mergeTreeConflict` fails only in the archive, which has no `.git`.

Limits, named:
- `grep -c "the other repositories' lanes" src/work-gate/pacing.ts` prints 3, not the row's 1: two doc-comment mentions beside the code line. Not forced.
- `pnpm run lint` does not exist in this repository (`Missing script: lint`).
- The gate's pacing is between the floor and the reserve: the other repositories are read in full (PRs and tracker lanes), not PRs only. Splitting the lanes is beyond this row.
- Pre-existing, not changed: `pacedUnread` names the other repositories as unread whenever paced, even on runs where they are still read.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
