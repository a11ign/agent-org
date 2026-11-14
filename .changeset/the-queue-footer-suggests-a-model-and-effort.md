---
"agent-org": minor
---

The queue footer suggests a model and effort (A11-435): while tickets are selected, it reads `Suggested: sonnet/medium · 94% first-pass, n=31, on dependency-update tickets in agent-org` when past runs of a label the selected tickets share, in their one repository, give one. The suggestion comes from the outcome log (A11-430) through the new `GET /api/suggestion?keys=`, and only advises: Queue sends the batch's own model and effort, as before. A model and effort needs `tickets.suggestMinSample` decided runs (20 by default) before it is suggested; with fewer, nothing is shown. An outcome log that cannot be read shows `No suggestion:` with the reason.
