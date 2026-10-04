---
"agent-org": patch
---

`chairman:reply` now hands `createGhReaders` the files `{{fleet.workers-up}}`, `{{fleet.workers-down}}` and `{{gate.last-tick.age}}` read: the two `fleet-watch` files under the project's `runs/`, and the work-tick completion record beside the wake ledger (as `messaging:watch` names them). The wake ledger's directory is resolved when asked, so a host that cannot name it costs `{{gate.*}}` alone, with a diagnostic on stderr, and the command still loads outside a configured host (a11ign/a11ign#3446).
