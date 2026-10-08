---
"agent-org": patch
---

The board-truth audit's flag for a handoff written as prose now reaches its author as an order. `handoff-in-prose` and `reading-without-defect-row` were only listed in the day's table, which is read once a day, so the sentence moved nobody and neither did the flag. When the tick posts a day's table it now also adds `answer:<route>` to each row a finding names (the session the comment's first words name, else the row's owner), once per row and route, through `POST /issues/{n}/labels` (idempotent, and it creates a label that does not exist yet). The label goes before the table, so a table that fails to post is retried without a second label; a label GitHub refuses is logged and the others still go; a day whose table is already posted reads no comments and labels nothing. a11ign/a11ign#4250.
