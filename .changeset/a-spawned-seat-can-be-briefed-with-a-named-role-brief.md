---
"@a11ign/agent-org": patch
---

A spawned seat can be briefed with a named role brief, the engineer's by default (a11ign/agent-org#828, Phase 1b of a11ign/a11ign#4505, capability only). `addressed` takes an optional `briefRole` on its `spawned` branch, and `src/spawn-role-brief.ts` holds the list (`SPAWN_BRIEF_ROLES`: `engineer`, `orchestrator`) and `briefRoleSentence(role)`, which refuses any other name and any role whose brief file is absent, naming it. The engineer's sentence moved there unchanged, byte for byte. Nothing passes the option yet: no lane is routed, `SPAWN_CAUSES` and `spawnableRole` are untouched, so no behaviour changes.
