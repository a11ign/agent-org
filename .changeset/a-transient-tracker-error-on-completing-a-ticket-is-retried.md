---
"agent-org": patch
---

A transient error writing a run's result to the tracker no longer sends a finished run to Needs you (a11ign/agent-org A11-304). On 2026-10-26 A11-289 ended `done`, Linear's completion write failed with `fetch failed`, and the card asked the chairman to answer a question that did not exist. A network error, a 5xx or a 429 on the completion of a `done` (or on reading a ticket to record a proposed edit) now keeps the run running with the note "recording the result in the tracker (retrying)" and tries the write again on later ticks, after 5 s, 30 s, 2 min, 5 min and then every 10 min; the worker's outcome is not rewritten, and each failed write is a `tracker-write` event of its own in the run log, which the run's Timeline words. A refusal for the request itself (a 4xx that is not 429, a team with no completed state), or a transient error that lasts more than an hour, ends the run Needs you under the escalation list's `access` item, with the tracker's own words.
