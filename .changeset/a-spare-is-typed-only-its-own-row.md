---
"agent-org": patch
---

An idle `worker-<n>` spare is offered a ready row only when the row is the one it was named for (`spareLabelForRow`); for any other row `route` refuses it with `is for #<n> only: one instance, one row (#2407)`, so the order falls to the spawn path and starts a fresh worker. Before, a spare that held nothing in the registry was eligible for every row: `worker-4466` was typed five different rows in 30 minutes (journal, 2026-10-09 09:15-09:45Z) and none was ever claimed. The refusal reads as a capacity wait in `splitRefusals`, not a fault. agent-org#459.
