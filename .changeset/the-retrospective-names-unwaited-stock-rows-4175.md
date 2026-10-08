---
"agent-org": patch
---

The daily retrospective prints how many `backlog` or `parked` rows have no wait that moves them, and names them (a11ign/a11ign#4175, #4055 item 5). A row counts when its stock label was applied more than 24 hours before the reading (the timeline's `labeled` event, so a comment cannot reset it) and it carries no `answer:*` label, no open `blockedBy` edge, no `Waiting-for:` or `Waits-on-done-when:` line and no `Not-before:` still in the future. `unwaitedStockRows` is the new `NUMBERS` entry (lower is better). A read the tool could not make (the issue list, a row's edges or its timeline) makes the number `unknown` and names the read; it does not drop the row, and it is never `0`. No `org-health` detector, no wake and no change to `idle-with-open-rows`.
