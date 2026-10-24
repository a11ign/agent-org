Closes A11-238

Step 2 of 2 (agent-org): the board hands an approved, green stacked pull request back to the arm bot, and shows GitHub's refusal on the card. The code host contract is 1.16 with two optional operations, `stackMergeFactsOf` (is the pull request in a stack, where is its base, is it settled, and what did the arm bot's refusal comment say at which head) and `requestStackMerge` (a dispatch of the arm bot's `arm-approved` job; the board never merges). `retargetStacked` is the one writer of the run's per-pull-request notes: for each open, ready pull request it asks `stackMergeStep`, which asks only for a stacked pull request based on the default branch, once per head per 15 minutes, never at a head GitHub refused, and notes GitHub's reason instead. A pull request not in a stack is never handed over. The worker brief says a stacked step needs no person to merge and that a stack is never unstacked.

Acceptance:

```bash
node --test src/ticket-mode/stack-merge.test.ts plugins/github/stack-merge.test.ts src/ticket-mode/worker-files.test.ts src/packaging/auto-arm-stack-merge.test.ts
npm run typecheck
```
