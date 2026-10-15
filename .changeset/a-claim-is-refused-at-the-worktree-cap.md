---
"@a11ign/agent-org": patch
---

A claim that would create a worktree is refused, before any write, when its checkout already holds `WORKTREE_CAP` (100) or more live worktrees, the main one included (agent-org#1036, incident a11ign/a11ign#3846). The refusal names the count and the prune (`pnpm run worktrees:prune -- --apply`); a count git cannot give is thrown, so no tree is made on a guess. `claimWithWorktree` asks the count after the adoption branch and before the fetch, and `row-claim-worktree-cap.test.ts` pins the cap at, over, and one under it. A claim that adopts an existing tree creates none, so it is not counted against the cap.
