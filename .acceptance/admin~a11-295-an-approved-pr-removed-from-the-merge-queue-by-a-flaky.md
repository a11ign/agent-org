A pull request the merge queue removed is put back in the queue by the board when the change did not cause it: a removal whose failed `merge_group` jobs failed before the code ran (an `ETARGET` install log, a registry 5xx, a lost runner, a job that failed at "Set up job") on a pull request still approved at the same head dispatches the arm workflow once and starts no worker round, at most twice for a head, and the third removal starts a round; a worker round for a removal that ends with no push dispatches it too, and the log names why the pull request was out of the queue.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-merge-queue.test.ts
```

Consumer-declaration: none -- no host file, setting or plugin contract changes meaning. `requestStackMerge` (contract 1.16) is used for one more caller, and a `round` record written before this change that names its jobs is read as a round that was started, so a pull request it left out of the queue is armed again once by the first watch after the update (the recovery the ticket asks for).
