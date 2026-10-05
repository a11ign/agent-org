---
"agent-org": patch
---

`trace --aggregate` (and `--map`) survive a transient GitHub 5xx (a11ign/a11ign#3700). One `HTTP 500` on a check-runs list killed a 1,500-call pass with an uncaught stack and no report. `budgetedGh` now tries a 500, 502, 503 or 504 again after a pause (2 s, then 4 s), up to 3 tries in all; EVERY try is a counted, paced and floor-checked call, so the budget line's total includes them. A 4xx (404, 403, 422) is an answer and is never retried. A call that outlasts its tries stops the run like the budget or the floor does (`reason: "failure"`): the pull request in hand is named unread, what was read before it stays in the store, the footer says `STOPPED AT THE GITHUB ERROR: stopped at gh api <url>: HTTP 500 after 3 attempts`, and a failure while listing the merged pull requests (where there is no report to give) is that message on stderr with exit 1, no stack. The single-number `trace -- <n>` reads through `ghApi` and is not changed.
