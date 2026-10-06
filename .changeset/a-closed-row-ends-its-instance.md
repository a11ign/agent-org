---
"agent-org": patch
---

A row CLOSED while it still carries the claim has its claim released by the gate, and its per-row `worker-<n>` interrupted when herdr reports it `working` (a11ign/a11ign#3535). A new `closed` release reason sits beside `stalled`, `blocked`, `merged` and `gone`; the interrupt is an Escape with no prompt (a stop, so no wake is spent), after which `spareDecision` ends the instance as it ends any that holds no open row. A standing seat is released and never interrupted; a row closed by its own pull request keeps the merged release it has. The read is ONE aliased `api graphql` call for the rows of the listed `worker-<n>` instances (`issue(number: n)` each), made ONLY when herdr lists at least one and asked inside the follow-ups' wave, so a tick of an org running no instance pays nothing (`GH_READS.conditionalOnListedWorker`, not an unconditional read). It is asked by number and not by `--label in-progress`, which today returns 264 closed rows that nobody holds.
