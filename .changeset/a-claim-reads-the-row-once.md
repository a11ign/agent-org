---
"agent-org": patch
---

`row-claim claim` asks GitHub for the row's `body` and its `blockedBy` edge once each, not twice. The template check and B4's Region lookup both read the body, and the claim's own check and B2/B4's both read the edge; the checks before the first write now share one `gh issue view`/`list` per distinct read. The labels are still read fresh before the checks, before the write and after it, a read that fails is retried, and no check or refusal changes. Measured against a live row through a proxy `gh` (writes faked): 16 reads before, 14 after. a11ign/a11ign#3566, slice 5 of the tick's cost.
