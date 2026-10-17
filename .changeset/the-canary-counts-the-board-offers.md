---
"agent-org": patch
---

The machinery canary now reads `board-disagrees-with-reality` as the number of board offers the tick made, not as unknown. It was never sourced, so a flag whose only effect was to make board offers noisily could not read `degraded` and the canary could not revert it. An unread board is still unknown and never zero (a11ign/agent-org#1716, a11ign/a11ign#5681).
