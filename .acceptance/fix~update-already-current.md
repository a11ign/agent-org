`install.sh` and `agent-org update` install dependencies with the pinned pnpm through Node's corepack (`TOOL_PNPM_VERSION` and `pinnedPnpm` in `src/install/pnpm.ts`, `PNPM_VERSION` in `install.sh`); `agent-org doctor` checks that pnpm runs (`pnpmCheck` in `src/install/doctor.ts`); and `update` refuses, non-zero, when an install fails, saying whether the checkout is already at the release (`installRefusal` in `src/install/update.ts`).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install
```

Consumer-declaration: none -- the installer's own pnpm; no command, flag or file a host declares changes.
