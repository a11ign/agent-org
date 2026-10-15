---
"@a11ign/agent-org": patch
---

The work gate decides once whether its process is the gate: `tick.ts` imports `isGateProcess` from `reads.ts` instead of keeping its own copy of the same argv test (a11ign/agent-org#1146). Behaviour is unchanged.
