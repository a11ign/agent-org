---
"@a11ign/agent-org": patch
---

The daily retrospective's read has its own per-tick budget (a11ign/agent-org#1089). Once the DORA read was complete, the rest of the read (merged lists, open pull requests, journal, transcripts, GitHub reads) ran in one tick with no budget, past the gate's 300 s, so the tick was cut before the order was written and the day was never delivered. Now the read is made in ordered classes (`retroClasses`), and a tick does not start a class once `RETRO_TICK_BUDGET_MS` (60 s) has passed, always reading at least one. Each class's fields are kept in `retro-read-classes.json` as they are read, and the memory's used marks are kept with them, so the next tick resumes at the first unread class. The order is offered only when every class is read; a cut tick logs `org-retro: read stopped at <class> after <n> s` on stderr and offers nothing.
