# agent-org: working in this repository

The commands, run from the repository root:

- **Install:** `pnpm install`. The lockfile is `pnpm-lock.yaml`; pnpm is the version `release.yml` pins (10.34.5).
- **Test:** `npm test`. The suite runs only where its files exist: CI's `suite` job copies the fixture project to a temporary directory and runs rstest with `AGENT_ORG_HOST` naming that copy's host declaration (`.github/workflows/ci.yml`). From a bare checkout `npm test` refuses and prints the narrow form: rstest on the changed test files, with `AGENT_ORG_HOST` set to a host declaration.
- **Typecheck:** `npm run typecheck`.
- **Lint:** `npm run lint`. ESLint with `@george2f/eslint-plugin-clean-code` over `src/`, `scripts/`, `plugins/` and `ui/` (`.ts`, `.tsx` and `.astro`), configured in `eslint.config.ts`.
- **The UI** (`ui/`, a private package of its own with its own lockfile, not a workspace member): `pnpm --dir ui install` once, then `pnpm ui:dev`, `pnpm ui:build`, `pnpm ui:typecheck` and `pnpm ui:test` from the root. `ui:test` needs the build and Chromium (`pnpm --dir ui exec playwright-core install chromium`). The README's section "The board UI package" says how it works.

Fix every lint error before you push. A rule that is still at `warn` in `eslint.config.ts` has its own follow-up ticket, which fixes its warnings one rule at a time, so leave those warnings alone unless your ticket is that one. A warning does not fail `npm run lint`.
