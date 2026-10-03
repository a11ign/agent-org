---
"agent-org": patch
---

A keyed review checkout is refused, not handed over, when the repository's clone lacks a package the pull request's `package.json` declares: the reviewer used to start on a tree that could not run its tests and die on `ERR_MODULE_NOT_FOUND`. The refusal names the missing packages and the `npm install` that supplies them. `package.json` now declares the three packages the tests need (`tsx`, `yaml`, `typescript`) as `devDependencies`.
