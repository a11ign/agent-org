---
"@a11ign/agent-org": patch
---

The worktree prune refuses a dirty tree that holds intent-to-add entries (`git add -N`) before it writes any ref (a11ign/agent-org#825). `git stash create` cannot pin such a tree and refuses it with `not uptodate. Cannot merge.`, so the refusal now names the count, the first three paths, and git's stderr in the reason, and the tree is left as it was. Its content is not pinned.
