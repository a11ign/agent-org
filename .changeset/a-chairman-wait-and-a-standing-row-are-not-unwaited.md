---
"agent-org": patch
---

The retrospective's "Unwaited stock rows" no longer counts a `needs:chairman` row or a `meta` row. The 2026-10-09 report printed `2: #20; #2568` and could never read 0: #20 is the daily board report's standing `meta` row (`backlog` by design, no condition to wait for) and #2568 is a chairman wait that `chairman-blocked`'s daily reminder already moves, so a genuinely forgotten third row would have been invisible beside them. Each label is now read as the wait it is, before any timeline is fetched; the exemption is the label the row carries and not a list of numbers, so a new standing row needs no code change. The report's wording for a counted row is unchanged. a11ign/a11ign#4323.
