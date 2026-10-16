---
"agent-org": patch
---

agent-org names no project in its non-test source (a11ign/agent-org#1591). The project is read from `.agent-org/project.json` through `project-config.ts`, or taken as a parameter. `crash-recover` resolves its default host declaration when it runs, and with `AGENT_ORG_HOST` unset and no checkout resolvable it now refuses (exit 70) instead of reporting "nothing done" and exiting 0.
