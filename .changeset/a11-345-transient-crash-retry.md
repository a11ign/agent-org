---
"agent-org": patch
---

A run that crashes on a transient network error (`fetch failed`, a reset, a timeout, a DNS failure, an undici socket error or a 5xx) is queued again by the board after a back-off of 30 s, then 2 min, twice at most, and each retry is on the run's log. After the retries are used up, or for a crash with any other reason, the run reads Failed with its reason. A tracker write a run makes as it starts (the move to the working state and the claim) is tried again after a network failure and never crashes the run, the Linear client sends a query that failed with `fetch failed` once more on a connection that is closed after it, and the board's log line for a network error names the code under it (`fetch failed (UND_ERR_SOCKET)`).
