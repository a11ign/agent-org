---
"@a11ign/agent-org": patch
---

`src/work-gate.ts` is split into per-cause modules (a11ign/a11ign#5152), so gate fixes stop queueing one at a time behind the file-overlap rule. The entry goes from 9,441 to 627 lines and keeps the tick's `main` and the declarations that tests outside the gate's Region pin by position. Each cause family is a module under `src/work-gate/causes/` (`pr-*`, `rows-*`, `org-health-*`), and the shared GitHub reads, the orders' formatting and delivery, the shared vocabulary and the tick's helpers are base modules beside them (`reads.ts`, `orders.ts`, `vocabulary.ts`, `pr-state.ts`, `tick.ts`). No behaviour changes. `src/packaging/work-gate-size.test.ts` fails when the entry passes 1,000 lines or when a cause module imports another cause module or the entry. `docs/gh-call-baseline.json` and the git-spawn, one-decider, project-vocabulary and worker-profile registries move with the code they describe.
