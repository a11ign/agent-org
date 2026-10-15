---
"@a11ign/agent-org": patch
---

A reviewer tree laid before the tool checkout was pruned can be installed into (a11ign/agent-org#808). `update-tool` re-installs the clone `--prod` (#714), so the links a tree laid to the clone's devDependencies (`@rstest`, `@types`, `tsx`, ...) dangle, and `pnpm install` died `ENOENT ... mkdir '<tree>/node_modules/@rstest'` through one; the order was `UNDELIVERED` on every tick (reviewer-agent-org-782, 30+ ticks). `installIntoTree` now removes the tree's top-level `node_modules` links that do not resolve (`lstat` says link, `existsSync` says no) before it installs, and only those: a link that resolves and anything that is not a link are kept.
