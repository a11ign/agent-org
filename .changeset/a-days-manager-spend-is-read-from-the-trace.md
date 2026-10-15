---
"@a11ign/agent-org": minor
---

`trace manager-spend --day <YYYY-MM-DD>` prints a UTC day's manager spend (at the primary price and with cache reads at $0.20/M), manager wakes by outcome, and wakes served by a run, read through `readStore` and de-duplicated by event id, against the $109 baseline and the $60 to $80 target band. A wake with no `servedBy` is counted in its own figure and is neither run nor seat. a11ign/a11ign#4505, agent-org#903.
