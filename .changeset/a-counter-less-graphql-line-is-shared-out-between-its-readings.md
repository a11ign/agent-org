---
"agent-org": patch
---

The ledger's graphql points for a counter-less line are now shared out between the counter readings around it, not floored at one point. The ledger keeps one baseline per token window instead of per account, so an account that runs several token pools (`app:scheduler`) no longer reads most of its calls as floor. `--per-hour` and the hourly rollup that a trim writes settle the same way. a11ign/agent-org#1482.
