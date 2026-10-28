The board answers the first removal of an approved pull request from the merge queue, for a job the code failed, by rerunning the failed jobs of the `merge_group` run behind it, and asks no worker: the card reads "ejected from the merge queue: <job>, retrying". When the rerun passes it writes the failing test to the flake log and asks the arm bot to arm the pull request again, once for the head; when it fails again, has not concluded after 30 minutes, or the pull request is removed again at the same head, the failure goes to the run as a round that quotes the failing test, and the card reads "ejected from the merge queue: <job>, sent to the run". `src/ticket-mode/pool-merge-queue.test.ts` drives each of these (the cases named `A11-371`), over the fake code host, and on the board's `watchFeedback`.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-merge-queue.test.ts
```

Consumer-declaration: none -- no host file, setting or plugin contract changes meaning. `readCiRun` (contract 1.17) and `rerunFailedChecks` (contract 1.5) gain one more caller, a code host without `readCiRun` is answered as before (a round), and the board's queue file gains the optional fields `retried` and `retry` on a merge-queue record, which an earlier tool version ignores.
