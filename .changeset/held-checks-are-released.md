---
"agent-org": patch
---

A pull request whose check fails is no longer held for ever as "not this run's" (A11-429). Two holds never let go. A check that other runs' pull requests also failed was held even while main reported it passing, so a batch of runs that failed one check together held one another, and main going green released none, since none was waiting on main. And a ticket named in the check's error lines (a failing test's title, `… (A11-211)`) was taken as its owner even when that ticket was long done, so the board filed no fix ticket and the hold waited on a ticket that would never merge again. Now a check main reports passing is the run's own, whatever other pull requests do, and a named owner the board holds as completed, canceled or a duplicate counts as no owner.
