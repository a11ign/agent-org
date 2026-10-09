---
"agent-org": minor
---

The daily retrospective prints the chairman's corrections per UTC day beside the spend pace, with a day-over-day trend (`correctionsPerDay`, a11ign/a11ign#4453). An unreadable ledger reads as unknown, never `0`, and a day before the failure ledger existed has no baseline, so no trend fires for it. `chairman-correction` has no recorder yet (#4452 shipped only the `unidentified-caller-order` proxy), so until one exists the line reads `0` for every covered day and says so; the proxy is not counted as a correction.
