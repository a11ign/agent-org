---
"agent-org": patch
---

The wake's check before it starts an engineer (`spawnClaimability`) reads each declared repository's open pull requests together instead of one after another: the eight `gh pr list` calls, 3.9 to 5.3 s one at a time on the live host, now cost the slowest of them. The read goes through the batch the claim and the gate already use (`readWithFirstWaveTogether`), only for the wake's own `gh`, so a test's fake `run` still sees its calls one at a time. Same commands, same repositories, the list in the repositories' own order, and the same fail-open: a refused repository leaves the read inconclusive with the `row-claim: could not read <repo>'s open pull requests` line and the wake's `could not read the open pull requests` line unchanged. The read still happens before the worktree and the instance are made.
