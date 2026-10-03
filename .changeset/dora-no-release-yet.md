---
"agent-org": patch
---

`agent-org dora` reads a declared repository with no release yet as `no release yet`, not `unknown`: an npm package the registry answers 404 for (never published, told from a network error), a repository with no release and no merged pull request, and a repository whose issues are disabled (no `regression` rows can exist) are answers rather than refusals, while a reader that throws is still `unknown`. The reading also says which npm package it reads: one per repository, so a release of another package in the same repository is not a deployment.
