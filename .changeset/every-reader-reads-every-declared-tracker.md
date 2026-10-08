---
"agent-org": minor
---

The board-truth audit, the ready-label audit, the tick's heartbeat, `wakes-per-row`, `ci-health-liveness` and the board report read EVERY declared tracker, not `tracker[0]` or one `--repo` (a11ign/a11ign#4080, row 2 of #4056). A row of a keyed tracker is named `agent-org#N` beside the first tracker's `#N`; a read that fails on one tracker is reported for that tracker and hides none of the other's rows; with one declared tracker every output is what it was.
