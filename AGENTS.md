# agent-org: working in this repository

The commands, run from the repository root:

- **Install:** `pnpm install`. The lockfile is `pnpm-lock.yaml`; pnpm is the version `release.yml` pins (10.34.5).
- **Test:** `npm test`. The suite runs only where its files exist: CI's `suite` job copies the fixture project to a temporary directory and runs rstest with `AGENT_ORG_HOST` naming that copy's host declaration (`.github/workflows/ci.yml`). From a bare checkout `npm test` refuses and prints the narrow form: rstest on the changed test files, with `AGENT_ORG_HOST` set to a host declaration.
- **Typecheck:** `npm run typecheck`.
- **Lint:** `npm run lint`. ESLint with `@george2f/eslint-plugin-clean-code` over `src/` and `scripts/`, configured in `eslint.config.ts`.

Fix every lint error before you push. A rule that is still at `warn` in `eslint.config.ts` has its own follow-up ticket, which fixes its warnings one rule at a time, so leave those warnings alone unless your ticket is that one. A warning does not fail `npm run lint`.
