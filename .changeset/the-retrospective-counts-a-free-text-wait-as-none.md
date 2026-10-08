---
"agent-org": patch
---

The retrospective's "Unwaited stock rows" number no longer counts a `Waiting-for:` line outside the grammar as a wait. `parseWaits` keeps such a sentence as an `unreadable` wait, and the count asked only whether any wait line existed, so a row parked on "ceo's dispatched run ... ends" (#4090, ten hours) read as waited. A line counts when its state is not `unreadable` (`manual` still does); a row whose only wait is a sentence is counted and printed with `unreadable wait` beside it, and a real wait beside the sentence (an open edge, an `answer:*`, a future `Not-before:`, a readable `Waiting-for:`) still moves the row. `Waits-on-done-when:` is unchanged. The grammar is `parseWaits`'s own, not restated. a11ign/a11ign#4237.
