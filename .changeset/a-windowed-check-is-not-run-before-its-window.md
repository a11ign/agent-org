---
"agent-org": patch
---

The After-merge verifier no longer files a ticket for a check that was not ready or could not run. A check about a delay after release ("7 days after release", "over 7 days", or an `agent` check's plan `Window:`) is scheduled for its change's installation plus that window, shown as "due <date>" on its ticket's Run detail, and given to no verifier run before then; a check an earlier release closed failed for want of its week is opened again and scheduled. A verifier run that cannot run a check on this host ends `cannot-run-here`, naming what it lacks: the check stays open and the board files one ticket for each missing capability, not one for each check. A new-ticket run whose filed ticket cannot be read back from the tracker is read again with backoff, and if it still cannot be read its card reads Done naming the key the writer reported, not Failed (A11-361).
