---
"agent-org": minor
---

A running run that waits on its own background work is no longer shown as Stalled while it waits (A11-236). A `working` outcome may carry `waitingOn` (the job) and `until` (an ISO time). An idle run whose pane shows a live shell or Monitor, or whose note names a `waitingOn`, reads "Waiting on background work for <time>: <job>" until `until`, or three hours after the outcome was written when it gives none, and `tickets.stallMinutes` does not stall it meanwhile. Past that bound, with no newer outcome, it is Stalled and the reason names the job. The worker brief and the shipped house notes show the new `working` shape. A run with no live work and no named job stalls exactly as before.
