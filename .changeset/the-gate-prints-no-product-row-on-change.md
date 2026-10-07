---
"agent-org": patch
---

The gate prints `NO PRODUCT ROW OFFERABLE (share N/10)` when its state changes, and once a day while it stands, not on every tick the shelf is empty (124 lines in 3 h, which the repeating-lines detector rightly offered as a fault). `offeredByShare` remembers the last line in `product-share-line.json` beside `engineer-starts.json`; a tick that stocks the shelf (a product row on offer, or the share at the floor) clears it so a recurrence prints, and a memory that is absent, empty, unparseable or unwritable prints and never throws. The line's text is unchanged. a11ign/a11ign#3929.
