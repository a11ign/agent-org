---
"@a11ign/agent-org": patch
---

The gate's `unclaimed-blocker-cleared` order to `product-manager` now carries a `Head: <sha>` line, the `origin/main` commit the gate read that tick (a11ign/agent-org#1129). The `unclaimed-blocker-cleared` decision class guards `promote` on that line, so until now an order stated none and the class could never promote. When the gate could not read the head the order carries no `Head:` line, as before, and the order's key is unchanged so a moving `main` does not re-ask a clearing.
