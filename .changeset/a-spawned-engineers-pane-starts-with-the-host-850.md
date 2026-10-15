---
"@a11ign/agent-org": patch
---

A pane the gate spawns starts with `AGENT_ORG_HOST` set to the declaration the gate itself resolved (a11ign/agent-org#850), so `pr:open`, `worker:state` and the tests no longer refuse in a worktree of a repository that holds no `.agent-org/project.json` of its own; a caller's `override` still wins, and a spawn whose environment names a declaration that is not a file is refused naming it, before the claim. The role brief a spawned seat is sent to read is named by its absolute path in the home project, never relative to the worktree, for the engineer and for the orchestrator alike.
