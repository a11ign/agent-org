---
"@a11ign/agent-org": patch
---

The work gate's shared-file ordering can re-check a hold against the current files and put an approved, green pull request ahead of an unapproved one that opened earlier, and tell a DIRTY-against-`main` pull request to rebase now instead of holding it (agent-org#1165). All three sit behind `holds.recheck`, shipped OFF, so the ordering is unchanged until the flag is switched on. `sharedFileOrders` takes `{ recheck }`, defaulting to off.
