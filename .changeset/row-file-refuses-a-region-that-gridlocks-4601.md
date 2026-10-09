---
"agent-org": minor
---

`row-file` measures a new row's Region at filing and refuses one that expands to more than 20 files or overlaps more than 5 open rows and pull requests, unless it is split or declares a `Sweep:` line (a11ign/a11ign#4601, lock-gridlock fix 1 of 4).
