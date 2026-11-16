---
"agent-org": patch
---

The `pool-org-repos` test waits for a wrong-repo's clone and for the run it starts again, not for a fixed number of turns of the event loop, so a loaded runner no longer turns `suite` red on a run it read before the move finished (A11-401).
