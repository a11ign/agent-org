---
"agent-org": patch
---

agent-org lints its code with ESLint and `@george2f/eslint-plugin-clean-code`, the recommended Clean Code rules, all at `warn` except two that have no hits. `npm run lint` runs it over `src/` and `scripts/`, and CI's new `lint` job runs it and `gate` requires it. The workers' brief asks for lint beside the tests and typecheck, so a fix is linted before it is pushed. ESLint, `typescript-eslint` and the plugin are pinned exact.
