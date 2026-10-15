---
"@a11ign/agent-org": patch
---

A decision run can serve the `org-health` cause: `src/decision-run/classes/org-health.ts` is a `DecisionClass` whose `posted` answer posts the day's board-truth table on the record issue and whose `escalate` (the default) hands the order back to the standing seat, so a run never writes a per-row fix. Nothing is switched on: `seatModeOf("org-health")` stays `seat` until a project says otherwise. a11ign/agent-org#906.
