---
"agent-org": patch
---

The tick runs `row-file --promote` from a linked worktree it owns (`role-work-gate`, beside the checkout it runs from, detached at that checkout's HEAD), so an un-parked row is promoted to `ready` and not left on `backlog` + `answer:product-manager`. The tick's working directory is the tool's primary checkout, which `row-file`'s launch guard (#1352) refuses, so every promotion was refused (a11ign/a11ign#4159 twice, #4182, #4183). The guard is unchanged. A stale registration is pruned, a directory of that name that is not a worktree is refused by name and never touched, and a missing tree routes the row to `product-manager` with that reason. The log line names the worktree that ran the script. a11ign/a11ign#4202.
