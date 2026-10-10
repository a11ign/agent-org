---
"agent-org": minor
---

A claimed worker that stopped mid-task (`idle` or `done`, a claim naming a branch, no open pull request, no pending check and no declared wait) is now woken with a "continue" order after 10 minutes, measured from 912 sessions' own turn gaps (a healthy wait's 87.7th percentile; the rule's own answer, about 93 minutes, is above the 10-minute ceiling the row set, so the cap binds). A holder with a pull request keeps the 45-minute clock and the no-progress clock is unchanged. A session that restarted is told once that its background tasks are lost, detected by its agent-session id changing in `herdr agent list` (the claim comes before the process starts, so "started after the claim" would fire on every fresh start). Each stall nudge appends one `claimed-worker-stalled` line to the failure ledger, ref `<session>/#<row>/<nudge time>`, and a recorder that fails is reported and never stops the tick. a11ign/a11ign#4437.
