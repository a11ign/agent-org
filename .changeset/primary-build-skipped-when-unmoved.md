---
"agent-org": patch
---

`primary:update` no longer rebuilds the primary checkout when nothing moved. The build ran on every tick (the `work-tick` unit runs this step first, about 30 times an hour) and cost 11.6 to 12.4 s of wall clock and 27.6 to 29.9 s of CPU for a build that changed nothing, measured on a scratch clone at an idle host; that CPU is outside the tick process, so the `tick-cost` line never counted it. The build is now skipped only when ALL of these hold: HEAD did not move, the last SUCCESSFUL build was of this exact sha, and every `packages/*/dist` that build left is still there and not empty. The record is a stamp at `.git/primary-build-stamp.json`, written only after a build returns, so a failed build leaves none and is retried on every tick as before, and a `dist` somebody deleted is rebuilt. A project needs to do nothing to take it; the first tick after the release builds once and writes the stamp.
