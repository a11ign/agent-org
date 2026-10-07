---
"agent-org": minor
---

A wait that clears can ASK THE CHAIRMAN. A row declares the ask in advance with a `Then-ask-chairman:` block (the lines the alert source requires of a brief, plus `Declared: YYYY-MM-DD`) beside its `Waiting-for:` conditions; when EVERY condition is true the tick posts the declared brief (opening `BRIEF for the chairman`, with a `Condition true at <time>: <reading>` line and the declaration's date), puts `needs:chairman` on the row, removes the declaration it used, and tells `ceo` once. A condition it could not read, a row already labelled, and a malformed block raise nothing (a malformed block is reported to `product-manager` by name, since a brief missing a line sends no alert); `row-file` refuses a block that could never fire. `Waiting-for: published <pkg>@<dist-tag>` gains a floor, `>= x.y.z`, so "a real release" can be written down. #2885 and #2887 sat parked three days after their packages shipped. a11ign/a11ign#4020.
