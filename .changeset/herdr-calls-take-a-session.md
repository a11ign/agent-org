---
"@a11ign/agent-org": patch
---

The herdr calls that open a workspace, start an agent and close a workspace (`openPane`, `agentStartArgs`, `closedNote`, with `herdrReason`) move from `wake.ts` into `herdr-agents.ts`, and they and `readAgents`/`readAgentSessions` take an optional `{ session }`. Absent, every call names `--session org` exactly as before, so the tick's behaviour is unchanged. A second mode can now run the same calls in its own herdr session.
