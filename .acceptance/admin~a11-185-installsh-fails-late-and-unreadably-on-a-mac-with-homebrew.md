`install.sh` checks git, tar, Node and a way to run pnpm before it clones anything and lists every problem with its fix command; runs pnpm 10.34.5 through the corepack beside node, a corepack on PATH, or `npm exec`, saying which when it is not the usual; and prints a header, one marked line per step, the outcome and the next commands (colour only on a terminal; `agent-org install OK:` / `agent-org install FAILED:` otherwise). `agent-org update` and `doctor` use the same pnpm order. The README names the prerequisites and the Homebrew note.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install/install-sh.test.ts src/install/pnpm.test.ts src/install/doctor.test.ts src/remedies-say-pnpm.test.ts
grep -q "Prerequisites" README.md && grep -q "brew install corepack" README.md && grep -q "npm exec" README.md
```

Consumer-declaration: none -- no host file key changes meaning.
