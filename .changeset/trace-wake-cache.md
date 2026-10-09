---
"agent-org": minor
---

`trace -- --wake-cache` prints the cache write of the first turn after each wake, per standing seat (a11ign/a11ign#3563). Each wake's window is classed kept, compacted or cleared, and its gap since the seat's previous turn is classed up to 5 minutes, up to an hour or over an hour, so the two candidate causes of a re-wake's ~30k-token cache write (the window emptied, or the cache's lifetime lapsed) read as separate figures. What a wake did to the window is derived, not read (`last-order/` holds the last order's time only): a compaction between the turns is `compacted`, a new transcript file (a /clear starts one) is `cleared`, the same file is `kept`. A class no wake could be placed in prints `not derivable` and never 0; a Codex reviewer's request, which has no cache-write field, is counted apart; every definition is printed once at the top. `src/trace/wake-cache.ts` is new.
