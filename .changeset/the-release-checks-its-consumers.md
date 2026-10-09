---
"agent-org": patch
---

The release checks its consumer before it tags (a11ign/a11ign#4412, b of #4407). `release.yml` gains a `consumer-check` job that the tagging job `release` `needs`: it runs `src/public-interface.test.ts` (every declared subpath and name is still delivered), then `src/release-consumer-check.test.ts` against a11ign/a11ign's current `main` (every `agent-org/<subpath>` and name a11ign imports is in the declared list). A red check leaves the tag uncut, so a rename that breaks a consumer, as v0.88.0's `.mjs` -> `.ts` did, is held at the merge and never ships. `release-consumer-check.test.ts` pins the job, its order and that nothing excuses it, with a negative control for each; `release-tag-on-merge.test.ts` and `release-triggers-itself.test.ts` now expect the two-job shape.
