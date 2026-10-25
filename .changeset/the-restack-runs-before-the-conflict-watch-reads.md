---
"agent-org": patch
---

The board's feedback watch restacks the stacked pull requests before it reads any for a conflict (A11-248). The server runs the watch and the restack on separate timers, so when the member below merged and GitHub read the member above as conflicting at once, the watch could start a plain conflict round that named neither the stack nor the merged member. The pool's `watchFeedback` now runs the restack first, so the conflict round is the restack's, naming both; a restack that throws is said in the log and the watch still runs. The restack stays idempotent per merged member, so nothing is restacked twice. A stacked finished run's pull requests are now read twice an interval instead of once.
