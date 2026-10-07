---
"agent-org": minor
---

`trace --aggregate` cuts each week BY REPOSITORY, reads agent-org's and lab's weeks BEFORE and AFTER their move apart (the week that holds the move is on neither side), and prints for each cut the FIRST-TURN SIZE of the per-row sessions and the TOOL-READ TOKENS (`Read`, `Grep`, `Glob` results, measured from the window's growth, stored on each turn as `toolRead`) apart from the start-up context. The ingest state is version 4, so every transcript is read again once to carry the new field. A figure the store cannot hold prints `not held`, never 0 (a11ign/a11ign#3967).
