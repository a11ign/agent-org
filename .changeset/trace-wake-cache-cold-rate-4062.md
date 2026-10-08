---
"agent-org": minor
---

`trace -- --wake-cache` prints each seat's 5-minute and 1-hour cache-write totals and the cold-wake rate of #4055 move 3 (a11ign/a11ign#4062): the share of first requests after an order whose cache write is MORE than half of input + cache read + cache write. The rate is printed over all of a seat's first requests, per window action (kept, compacted, cleared) and per gap, so a cold first request after a window the gate emptied reads apart from one after a cache that lapsed. A seat or class with no first request prints `not derivable` and never 0%.
