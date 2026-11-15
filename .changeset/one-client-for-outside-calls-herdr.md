---
"agent-org": patch
---

The pool's herdr calls now go through the one client for outside services (A11-436 step 3 of 3), as Linear's and `gh`'s do. Each call is cut at its own time and made once; herdr's breaker refuses at once with "herdr is unavailable" after ten failed calls in a row; and the call counts once in a new `herdr` figure. A herdr that never answers now fails as transient, and the start error keeps herdr's failure as its cause, so a run whose start it failed is started again by the board instead of being left crashed. `/api/health` serves `outsideCalls`, every outside call as one failure figure, beside each service's own, and the board's header reads "Failed calls per 100: <all> (Linear …, GitHub …, herdr …)". A crashed run's recovery also waits for herdr's latest call to succeed.
