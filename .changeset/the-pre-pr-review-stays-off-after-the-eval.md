---
"agent-org": minor
---

The worker eval can now measure the review of a worker's local diff before its pull request opens (A11-440, step 2 of 2). `node scripts/run-eval.ts --set <set> --key tickets.localReview=on` has each worker run the same pre-PR review a board's worker would, offline, and counts the reviewer's tokens; `node scripts/run-eval.ts bar` sets the off and on runs against the bar for turning the setting on by default. Run on the first set, the bar was missed: 5 of 10 tickets convinced with it off and with it on, and the reviews cost about 6.1M tokens with no feedback round saved. So `tickets.localReview` stays off by default, and its description in Settings says why.
