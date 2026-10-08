---
"agent-org": patch
---

CI now runs the shared layout check (a11ign/a11ign#4211, ADR 0043 Decision 7), so the flat shape this repository is the model for cannot drift into a monorepo unseen. One step in the `typecheck` job of `ci.yml`, which the required `gate` waits for, runs `@a11ign/toolchain`'s `layout-check` and fails on a workspace of one package, a package directory not named for its package, a second README for one package, or a `lerna.json` / `*-workspace` shell. The `@a11ign/toolchain` devDependency moves from `^0.1.4` to `^0.1.5`, the first version that ships the check. Measured on `d51ea83` with 0.1.5: `layout-check: ok (963 files read ...)`, exit 0. The step calls the file by path (`node node_modules/@a11ign/toolchain/dist/layout-check.mjs`) because 0.1.5's bin has no `#!` line and the published one-liner exits 2 under `sh`.
