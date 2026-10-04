---
"agent-org": patch
---

`src/merge-guard/merge-ref-staleness-rule.mjs` is deleted, with its test: `fetchMergeRefBehindBy` ran `git fetch origin pull/N/merge`, `rev-parse` and `rev-list` with no `cwd`, so a caller on the tick would have read the tool's own checkout instead of the project's, and nothing called it. `mergeRefIsStale` and `mergeRefStalenessReason` had no caller either (`git grep` at `origin/main` found only the module's own test), so they go too rather than wait for one. (a11ign/a11ign#3367)
