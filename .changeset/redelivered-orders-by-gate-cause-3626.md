---
"agent-org": minor
---

`trace -- --aggregate` prints, under the re-delivered line of each week, the re-delivered orders BY GATE CAUSE (a11ign/a11ign#3626): the repeats of each cause, its distinct keys, the median gap between a repeat and the previous delivery of its key, and dollars (a floor, `not derivable` when every turn is unpriced), most repeats first, in the same week as the class and adding up to it. A repeat whose key carries `@deferred` is the same order re-sent after a deferral and is its own row (`<cause> @deferred`), since a deferral retry and a wake delivered anyway are different defects. A week with no repeats prints no table, and `--json 1` carries the rows as `causes` on the class.
