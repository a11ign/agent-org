---
"agent-org": patch
---

A keyed repository's dependency change no longer costs a reviewer. When the clone's `node_modules` lacks a package the pull request's `package.json` declares, the tick installs into the REVIEW TREE (`pnpm install --frozen-lockfile --ignore-scripts` when the tree has a lockfile, `--no-lockfile` when it has none) instead of refusing; the shared clone is never written. When that install fails the refusal names the first line of pnpm's failure and a hand remedy that works over a clone that already has a `node_modules`: `rm -rf <clone>/node_modules && cp -a <tree>/node_modules <clone>/node_modules`. The old `mv <tree>/node_modules <clone>/node_modules` moved the tree's directory INTO an existing one (`node_modules/node_modules`) and left every package missing.
