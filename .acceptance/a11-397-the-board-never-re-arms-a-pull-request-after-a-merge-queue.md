After a merge-queue removal that the change did not cause (an infrastructure failure, a lost runner), the board asks the arm bot to arm the pull request again when its head is approved by the board's reviewer alone. The merge queue's `approvedAtHead` predicate (`src/ticket-mode/pool-merge-queue.ts`) is true when `approvedAtHead` or `verdictAtHead === "approved"`, `verdictAtHead` is not `changes-requested`, and GitHub's review decision is `approved` or absent; `PullFeedback.approvedAtHead`, `feedbackIgnores` and the contract are unchanged, so the reviewer's reviews and comments are still left out of the feedback. A pull request with no approval at its head, or whose newest verdict or review decision asks for changes, is still not armed again.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-merge-queue.test.ts
```

Consumer-declaration: none -- no host file, contract or setting changes meaning.
