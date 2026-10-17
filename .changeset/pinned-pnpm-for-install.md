---
"agent-org": patch
---

`install.sh` and `agent-org update` install a release's dependencies with one pinned pnpm, 10.34.5 (the version the releases are built with), run by version through the corepack Node ships beside `node`. They no longer use whichever pnpm is first on PATH, or corepack's default pnpm, either of which can be a version that machine cannot start. `agent-org doctor` gains a `pnpm` check that this pnpm runs. `agent-org update` now exits non-zero when it cannot install a release's dependencies, and says when the checkout is already at that release rather than "NOT moved".
