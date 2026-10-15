---
"@a11ign/agent-org": patch
---

The ticket port reads a repository's open pull requests through `readOpenPullHeads`: number, url, head branch and label names, read through an injected runner. A refused runner, a non-list answer and a listing that fills its limit are each a named failure, never an empty list. Nothing calls it yet; agent-org#1167 is its consumer, so nothing changes in behaviour. `defaultGh` in `worktree-removal.ts` is exported, its spawn unchanged (agent-org#1193).
