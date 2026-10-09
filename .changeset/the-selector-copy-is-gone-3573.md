---
"agent-org": minor
---

The tool no longer carries a test selector (a11ign/a11ign#3573). `agent-org select-changed-tests` is removed from the command table with its `src/lib/select-changed-tests.mjs`, and the declared copy of `ci-changed.mjs` loses its test-selection half (`testPackages`, `dependentsOf`, `readWorkspaceDependencyGraph`; `classify` now takes `(files, packages, { repoRoot, getPackedFiles })`), because the product's PR `ts` job runs the whole suite and `rstest run --changed` is the one selector left. Job gating is unchanged. `src/lib/walk-scope-discovery.ts` is a new declared copy of the product's `packages/guards/src/walk-scope-discovery.mjs` (`packageIndex`, `sourceClosure`), which `walk-scope.mjs` now imports in place of the deleted selector. A project that still calls `agent-org select-changed-tests` must stop before taking this release.
