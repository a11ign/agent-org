---
"@a11ign/agent-org": patch
---

The worktree prune's salvage ref is named per tree, not per directory basename. Two dirty trees that shared a directory name (`…/a/tree` and `…/b/tree`) pinned to the same `refs/salvage/<name>-<epoch>`, so the second `update-ref` refused with `reference already exists` and its work was kept but not salvaged. The name now carries 8 hex digits of the tree's absolute path: `<basename>-<hash>-<epoch>` (and `…-head-<epoch>` for a detached HEAD). A failed `git stash create` or `update-ref` now names git's stderr in the "could not be pinned" line (first 200 characters), not only the command that failed. a11ign/agent-org#807.
