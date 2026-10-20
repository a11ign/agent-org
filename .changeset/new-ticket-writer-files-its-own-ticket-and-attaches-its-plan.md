---
"agent-org": patch
---

New ticket's writer runs the create-ticket skill in full in both modes, and files its own ticket and attaches its plan through the tracker's tools (A11-135). The board no longer makes tickets from draft files: it reads the run's outcome, checks each key it names against the record the hook kept as each ticket was created, reads each ticket back from the tracker, and shows it as a link. The writer may create one ticket with no `id` and attach files to a ticket it created; the hook refuses an update, a `blocks` relation, an attachment to any other ticket, and an eleventh creation. A build worker is refused every filing tool by name, and the refusal says to use New ticket.
