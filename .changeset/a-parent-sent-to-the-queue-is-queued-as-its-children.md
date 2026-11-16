---
"agent-org": patch
---

A parent ticket sent to the queue is queued as its open sub-issues instead of refusing the whole batch. A writer run that filed an epic (A11-429 and its 19 children) handed the parent to the queue with its children, and Select all on a page listed before the sub-issues existed picked the parent's checkbox: both were refused with "a parent is not queued", and nothing was queued. `POST /api/queue` and a writer run's queueing now replace each parent with its open sub-issues, in the order Queue its children uses, a sub-issue that is itself a parent by its own sub-issues, and a ticket named twice once. A parent is still never queued itself.
