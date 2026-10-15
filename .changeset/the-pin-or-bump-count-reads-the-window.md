---
"agent-org": patch
---

The retrospective's hand-filed pin-or-bump count reads the issues created in the last 7 days, newest first, stopped at that boundary, instead of every issue of the repository in one list capped at 1,000. A repository past 1,000 issues read `unknown` on every day; it now reads the count, and a window longer than the pages the read may walk still reads `unknown`, never 0 (agent-org#1430).
