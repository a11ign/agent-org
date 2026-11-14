---
"agent-org": minor
---

A ticket worker can have the reviewer review its local diff before its pull request opens (A11-440, step 1 of 2), behind the new `tickets.localReview` setting, which is off by default. When it is on, the worker's brief asks it to run `agent-org ticket:review-local` after its last commit, fix each blocking finding and run it again, and `pr:open` refuses to open the pull request until a review ran at the worker's current commit. A review that is still not convinced, or a reviewer that could not run, lets the pull request open only when its body says why under `## Local review`. The reviewer is the one the eval harness asks: Codex, read-only, with the `row-review` skill and the ticket as the spec. The board's own review of each new head still runs after the pull request opens.
