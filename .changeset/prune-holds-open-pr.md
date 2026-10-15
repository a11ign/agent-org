---
"@a11ign/agent-org": patch
---

Behind `prune.holdOpenPr` (off unless ON in `machinery-canary.json`), the worktree prune keeps a removable tree while an open PR names it: a PR whose head branch is the tree's branch, or whose labels carry the tree's session. The held line names the PR. A listing of open PRs that cannot be read keeps every removable tree and says so. Off, the prune is as before and GitHub is not asked. `src/prune-worktrees.ts`. a11ign/agent-org#1167.
