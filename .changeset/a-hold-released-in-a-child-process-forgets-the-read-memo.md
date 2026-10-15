---
"@a11ign/agent-org": patch
---

The gate's read memo is forgotten after a hold is released in a child process. `releaseHoldViaModule` runs `pr-hold.ts --release`, whose `gh` writes the memo cannot see, so a read of the same pull request later in the tick was answered from before the release. The memo is now forgotten once the child returns, whether it exited 0 or not (a11ign/agent-org#1145).
