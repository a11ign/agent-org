---
"agent-org": minor
---

`row-file` refuses a body whose `## Done-when` has an item the row cannot finish through: one naming a future time (`on day 3`, `after 2026-10-12`, `in three days`, a timestamp after the clock), a seat's or the chairman's act (`ceo approves`, `confirmed by the chairman`), or another row's outcome (`once #4438 merges`). The refusal offers the split: the second row's Done-when and the `Not-before:`, the `answer:<session>` or `needs:chairman` label, or the `--blocked-by` it would carry. A wait already carried as data on the row (a `Not-before:`, a readable `Waiting-for:`, a `Waits-on-done-when:`, a `--blocked-by` edge, an owner label) is not refused, and neither is a row, a seat or a date that is only cited. `promote` does not run the check yet: it cannot see the live blocked-by edges. a11ign/a11ign#4640.
