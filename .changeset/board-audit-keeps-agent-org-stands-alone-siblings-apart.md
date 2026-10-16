---
"agent-org": patch
---

The board-truth audit no longer calls two sibling rows of the `agent-org stands alone` epic near-duplicates when they name different functions in `agent-org stands alone (<function>): ...` (agent-org#1583). The epic's rows share a title template and differ in one word, so each new sibling was flagged against the others and re-tripped `board-disagrees-with-reality`. A title not of that form, or two naming the same function, are still compared by words alone.
