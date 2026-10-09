---
"agent-org": patch
---

The gate counts the rows it shelves behind each holder, per tick and over time (`src/blocking-impact.ts`, a11ign/a11ign#4602, fix 3 of 4 for the lock-gridlock class). `BLOCKING_MIN_ROWS` (5) rows shelved for `BLOCKING_MIN_MINUTES` (30) minutes, without a break of more than 10 minutes between ticks, is an incident, raised ONCE per holder per episode: a `lock-gridlock` event in the failure ledger (ref `<holder>@<episode start>`, so a second episode is a second ref and the class can repeat), a comment on each held row, and a `ready-row-unclaimable` order to the holder reading `you are blocking N rows; land, split or release` and listing the rows. The record is `blocking-impact.json` in the state directory; the daily retrospective reads it and prints `Top blocker`, the holder with the most row-minutes in the window, or `unknown` for a record it could not read.
