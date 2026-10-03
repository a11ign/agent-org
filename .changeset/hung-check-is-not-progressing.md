---
"agent-org": patch
---

The work gate tells a pull request's owner when a required check has been running for more than an hour on a non-draft pull request: it used to be classified `progressing` for as long as it ran, and a check that hangs never stops, so a pull request held for review sat four hours with nobody told. The new stall reason `hung-check` is read from the `startedAt` the gate already has (no new API call, no timer), is keyed on that start so a re-run that hangs again is a new order, and is filed under `pr-checks-failing`.
