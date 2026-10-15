---
"@a11ign/agent-org": patch
---

With `worktree.rebuildCheck` on (shipped OFF), the wake refuses to start a worker in a claimed worktree whose `typescript` does not resolve, names the cause, releases the claim, and writes the refusal on the row once for that cause. A worktree whose `node_modules` link resolves nothing used to be handed to its worker, which then skipped the local typecheck and pushed straight to CI (a11ign/agent-org#1130). With the switch off, the spawn is unchanged (a11ign/agent-org#1169).
