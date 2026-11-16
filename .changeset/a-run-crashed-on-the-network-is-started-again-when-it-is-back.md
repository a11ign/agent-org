---
"agent-org": patch
---

A run that crashed only on transient network errors (A11-345's `fetch failed`) is started again once the board's own calls to Linear and GitHub succeed after the retry cap, which ended it for good: A11-231 stayed crashed for two days after the 10-28 outage and held A11-232 behind it (A11-399). The board waits 10 min, 30 min, then 2 h after each crash past the cap, and restarts a run at most 3 times in any 24 h. A run that crashed for any other reason is not restarted. A crashed run that queued tickets wait on says so on its card ("A11-232 waits on A11-231, which crashed", and what the board does next), and the waiting ticket reads "Waits on A11-231, which crashed" in place of a plain queued wait.
