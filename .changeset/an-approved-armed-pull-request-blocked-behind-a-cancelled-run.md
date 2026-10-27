---
"agent-org": minor
---

The board reruns the cancelled duplicate run of a required check that blocks an approved, armed pull request (A11-342). A push and the edit of the pull request's body each start a `ci` run of one head; a concurrency group cancels one of them, and the cancelled `gate` holds the merge (`mergeStateStatus` BLOCKED) though the other run's `gate` is green, so GitHub never queues the pull request (a11ign/announcement-emulator#32 at `8b3d0ba9`). When a finished run's open pull request is approved at its head, armed, BLOCKED, and the only non-green runs of its required checks there are cancelled ones, the board reruns those runs whole (`gh run rerun <id>`) once for the head, with no worker, and records a `cancelled-rerun` event in the run's log, which the run's Timeline words. The code host contract is 1.28: `PullFeedback.blocked`, `PullFeedback.cancelledRequired` and `rerunRuns`, all optional.
