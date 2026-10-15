---
"agent-org": minor
---

A manager's `pr list` and `issue list` are read from the gate's snapshot, not re-read through the API (agent-org#1517, widening #1510). The wrapper refuses a manager's list naming a heavy `--json` field (`statusCheckRollup`, `body`, `comments`, `reviews`, `files`, `commits`, `timelineItems`), or a `--limit` over 50 or none at all; the refusal names `agent-org gate-snapshot-read` and exits before the call and before the ledger. A manager's allowed list is priced off the pool's counter as `project item-list` is (`GH_DEBUG=api`; a caller's other `GH_DEBUG` is refused). A worker's and the gate's own lists are untouched. The new `agent-org gate-snapshot-read <prs|rows|board>` prints the gate's stored list with its age and makes no `gh` call. `recordPoolAlarms` names a session whose priced calls spend more than 500 points in a ten-minute window, once an hour.
