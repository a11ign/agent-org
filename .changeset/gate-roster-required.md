---
"agent-org": patch
---

The work gate is ruled to REQUIRE the project's roster (a11ign/a11ign#3675): `work-gate.mjs` loads only where `.agent-org/roles` exists, and refuses naming `roles.dir` where it does not. It imports `arm-pr.mjs` through `auto-arm-sweep.mjs` and `work-gate/org-health.mjs`, and `arm-pr.mjs` reads `sessions.json` at import. The #2174 constraint that it load without the roster is retired, and the two comments that designed around it (`work-gate/pr-owners.mjs`, `work-gate/pr-orders.mjs`) are corrected; no behaviour changes. `src/work-gate-loads-without-roles.test.ts` pins both directions.
