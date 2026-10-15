---
"@a11ign/agent-org": patch
---

The board-truth audit's duplicate question no longer pairs a pipeline verify row with the build it verifies. A row whose body names the other in a `Verifies: #n` line or a `<!-- verify-row: build #n -->` marker, in either direction, is not its near-duplicate, so `board-disagrees-with-reality` stops re-tripping on each `Verify <build title>` row the pipeline files when a build closes (a11ign#4901 against #4488). Two unrelated rows with similar titles still pair. agent-org#765.
