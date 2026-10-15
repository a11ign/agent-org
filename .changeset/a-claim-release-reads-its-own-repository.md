---
"@a11ign/agent-org": patch
---

The claim guard that refuses a worktree's removal reads its row in the repository the tree belongs to: a `wt-<key>-<n>` directory is the tracker keyed `<key>`, and a `wt-<n>` directory is the first tracker's. A key no tracker declares is refused as undeterminable, never read in the primary's repository, where the same number is another row. `rowsClosed` reads the same row (agent-org#1216).
