---
"agent-org": patch
---

A listed herdr agent whose pane is gone is ended, not a live holder (a11ign/agent-org#1413). `herdr workspace list` keeps a workspace whose pane was closed, in status `unknown`, so a closed row kept its claim labels while its `worker-<n>` stayed listed, and an order addressed to it was retried for ever. `readAgents` asks `herdr pane read` for each `unknown` agent's root pane and marks the entry `paneless` only when herdr answers `pane_not_found`; any other failure leaves it unmarked. The entry stays listed, so presence still means the seat exists and a start is not repeated. The closed-claim release does not count a paneless holder, so its labels are stripped on the next tick, and `sessionUnknown` treats its orders as unknown, so they are dropped at the existing `UNKNOWN_SESSION_MS` bound (#1416).
