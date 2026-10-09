---
"agent-org": patch
---

A reviewer for a pull request in a keyed repository now starts when its install fails only because a declared package is not published. `a11ign/lab#38`'s reviewer was `UNDELIVERED` for 30 ticks: lab declares `@a11ign/control`, which no registry holds, so `pnpm install` in the review tree answers `ERR_PNPM_FETCH_404` and the start path read "cannot install" as "cannot review". The tree is now linked with what the clone has, and the reviewer's order says the dependencies were not installed because the named packages are unpublished, to judge the Acceptance from the repository's `checks` run on the head and to say so in the verdict. Any other install failure (network, lockfile, a version the registry lacks, a 404 for a name the tree does not declare, or a 404 beside another error) still refuses, unchanged. a11ign/a11ign#4321.
