---
"agent-org": patch
---

The board-truth audit's day table asks two more questions of the last day's comments by org accounts (a11ign/a11ign#4232, the chairman's root cause 1: a handoff written as a sentence moves nobody). `handoff-in-prose` flags a comment that hands off in prose (`goes to <session>`, `<session> will file`, `<session> to file`, `for <session> to`, `I will ask <session>`, `Asked of <session>`) when its author neither filed a row nor added `answer:<session>` within 15 minutes of it; `reading-without-defect-row` flags a reading (`reading N of M`, `Ruling`) with no `Defect-row: #N` / `Defect-row: none -- <reason>` line. A fenced block is never read. The comments are read once per edition day by `postDaysTable` (one paginated REST call, plus the evidence only when a handoff comment exists), never by the tick; a refused read leaves the day's table unposted.
