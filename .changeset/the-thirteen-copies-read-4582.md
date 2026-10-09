---
"agent-org": patch
---

The declared copies in `src/lib/` all name an original that exists, so `copies-drifted` reads `clear` over the 19 of them and not `unknown`. `cli-flags.ts` named `packages/worker-fleet/src/cli-flags.ts`, which left the workspace in a11ign/a11ign#3504, and now names `scripts/cli-flags.ts`; seven copies (`ci-changed`, `isolation-gate`, `test-memory-cap`, `tree-wide-guard`, `walk-scope`, `walk-scope-discovery`, `worktree-resolution`) took the original's last commit and a recounted allowance, their only differences being JSDoc against TypeScript annotations and one renamed path. a11ign/a11ign#4582.
