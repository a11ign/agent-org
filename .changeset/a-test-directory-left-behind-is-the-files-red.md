---
"@a11ign/agent-org": patch
---

A test file's `tmpDirForFile` directory is removed even when the removal meets a failure, and a removal that still fails is that file's own failure rather than the merge queue's (a11ign/agent-org#987). The merge-queue run 38150393779 passed all ten cases of `dora-budget-spent-is-not-a-timeout.test.ts` and its directory was left with 4 of the 5 entries it was made with, so the removal began and stopped, and the run's teardown ejected an unrelated pull request. `src/lib/tmp-fixture.ts` now retries a busy removal, tries every registered directory whatever the one before did, throws the failures together naming each path, and removes what is left from the process's own `exit` for a fork that never reaches `after`. Test tooling only; no shipped command changes.
