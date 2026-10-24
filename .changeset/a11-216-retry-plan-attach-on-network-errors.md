---
"agent-org": patch
---

A planning run's plan that fails to attach to its ticket on a network error (`fetch failed`, a timeout, a reset) or a 5xx from the tracker is tried again by the board, after 5 seconds, 30 seconds and 2 minutes, from the files already in the plan folder, before it asks a person: the card says "attaching the plan (retry N)" meanwhile, and a fourth failure ends the run Needs you with "the plan could not be attached after 4 tries". A refusal the tracker answered with (a 4xx, a validation error) still goes to a person at once, naming it. The tracker contract is 1.7: an error `attachPlan` throws may carry the HTTP `status`, which the Linear plugin now sets (A11-216).
