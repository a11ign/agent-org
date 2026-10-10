---
"agent-org": patch
---

The Haiku trial report (`src/trace/haiku-tier-report.ts`) reads the rows closed since the window opened, not the 300 newest created: `gh issue list --limit 300` returned the newest CREATED, so a row opened before the 300th-newest and closed inside the window was never counted and `n` and the merged count were short by exactly those rows (a11ign/agent-org#707; 17 against `gh`'s 20 for the Haiku arm). The read now carries `--search "closed:<window start>..<now>"`, the window start being the earliest Haiku-model turn the store holds, and a read that fills the limit is halved and read again; a second that still fills it throws rather than print a short count.
