---
"agent-org": patch
---

`outside.acceptance` (a11ign/agent-org#1579, the epic "agent-org stands alone", a11ign#928): the outside home of a11ign's `acceptance` job, shipped OFF. `shadowAcceptanceVerdict` in `src/acceptance-commands.ts` does nothing unless the switches record it is handed (`readSwitches` over `.agent-org/decisions.json`) holds `outside.acceptance: true`; on, it records the #1502 org-side verdict beside the job's (`agree`, `disagree`, `not-compared`) and `blocks` is `false`. `orgSideAcceptanceVerdict` gains a `rowLabels` seam, which the job's `class` report needs and the outside run was not handed.
