---
"@a11ign/agent-org": patch
---

No behaviour change: the gate's stale-wait lift and board truth audit are each split into a read step and an effect step, run in the same order on the same data. `liftableWaits` and `readBoardTruthAudit` read; `applyHoldLifts` and `postBoardTruth` act. The read steps are tested against a recorded runner that refuses any effect (agent-org#1209).
