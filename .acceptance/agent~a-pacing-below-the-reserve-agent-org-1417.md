Below the reserve, a paced tick skips `orgHealth` first and keeps reading the other repositories until the floor. Before, the reserve skipped `orgHealth` and the other repositories' lanes together, so a settled-green pull request in another repository got no reviewer order for ~20 minutes each hour. Now `GRAPHQL_RESERVE` (1000) gates `orgHealth` only, and a new `GRAPHQL_FLOOR` (500, named with its reason beside it) gates the other repositories' lanes below it. `Pacing` carries `belowFloor` beside `paced`, and `src/work-gate.ts` keys the other repositories' reads and the event-unread check off `belowFloor`. A skipped lane is still reported unread, never clean.

The floor value is a judgement (half the reserve), not a measurement of what one tick's reads cost.

Acceptance:

```bash
cd /home/agent/repos/wt-agent-org-1417 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --test src/packaging/gate-graphql-pacing.test.ts
```

Needs `AGENT_ORG_HOST` set in the shell, as on `origin/main`: the test's import chain reaches `src/project-config.ts`, which refuses to load without it. Measured with `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json`. The command itself is unchanged.

Closes a11ign/agent-org#1417

Pinned by `src/packaging/gate-graphql-pacing.test.ts`. The read decision and the report are two helpers in `src/work-gate/reads.ts`, `otherScopesForTick` and `eventUnreadForTick`, and `src/work-gate.ts` calls them. The band test calls them with the real ambient `defaultRun`, real event-gate facts (a repository b whose sweep is due, and one that is fresh), and each band: above the reserve, between the reserve and the floor, below the floor. It checks which repositories are read and which are reported unread, and a flag-off and a non-ambient run read every repository. Between the floor and the reserve both repositories are read when the sweep is due, so an implementation keyed on `paced` fails there. A call-site test pins the two call lines in `work-gate.ts` and that `orgHealth` stays on the reserve.

Mutation, each file backed up to the scratchpad with `cp`, changed, run, restored with `cp`, and diffed byte-identical (measured before the rebase onto `origin/main`; my four files are unchanged by it):
- A: `GRAPHQL_FLOOR = GRAPHQL_RESERVE` (the old order): 2 red, including the band test.
- B: `src/work-gate.ts` event-unread check keyed on `pacing.paced` instead of `pacing.belowFloor`: 1 red, the wiring test.
- C (review rework, `src/work-gate/reads.ts`): `otherScopesForTick` reads no other repository on an ambient tick (`&& true`): 1 red, the band test.
- D (review rework, `src/work-gate/reads.ts`): `eventUnreadForTick` reports below the floor too (no `pacing.belowFloor ? []`): 1 red, the band test.
- E (review rework, `src/work-gate.ts`): the call site passes `{ belowFloor: tickPacing().paced }`, the old order: 1 red, the call-site test.

Measured on the rebased branch (`7d562fa3`):
- Acceptance, with `AGENT_ORG_HOST` set: `ℹ tests 28`, `ℹ pass 28`, `ℹ fail 0` (after the review rework; 27 before it).
- `pnpm run typecheck` exits 0.
- Related suites: `machinery-canary` 28/28, `work-gate-size` 4/4, `work-gate-source` 6/6.
- The 26 files that fail under `node --test` in this worktree were run on a `git archive` of the pre-rebase HEAD: the same pass/fail counts with and without the change. `queue-stalled.test.ts`'s `#3019` failures predate the change too. `mergeTreeConflict` fails only in the archive, which has no `.git`.

Limits, named:
- `grep -c "the other repositories' lanes" src/work-gate/pacing.ts` prints 3, not the row's 1: two doc-comment mentions beside the code line. Not forced.
- `pnpm run lint` does not exist in this repository (`Missing script: lint`).
- The gate's pacing is between the floor and the reserve: the other repositories are read in full (PRs and tracker lanes), not PRs only. Splitting the lanes is beyond this row.
- Pre-existing, not changed: `pacedUnread` names the other repositories as unread whenever paced, even on runs where they are still read.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
