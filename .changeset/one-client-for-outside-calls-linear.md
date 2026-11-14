---
"agent-org": patch
---

Calls to Linear now go through one client for outside services (`src/ticket-mode/outside-client.ts`, A11-436 step 1 of 3): each attempt is cut at its service's time, a failure is tried again only when the one rule (`failureKindOf`) says another try can get past it (the network, a 5xx, a 429; never a 401 or another refusal), a breaker per service refuses calls at once after 10 failed attempts in a row and lets one through again after 30 s, and a call counts once in `/api/health`'s call figure however often it is tried. The plan attach, the result write and a crashed run's restart read the same rule, so a run that meets an open breaker is retried like one that met a reset, not left crashed. The tracker plugin is handed the client as `deps.outside`; `deps.retryFetch` is gone. `gh` and herdr move onto the client in steps 2 and 3.
