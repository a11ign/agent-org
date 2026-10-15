---
"@a11ign/agent-org": minor
---

The work gate knows a second priority label, `priority:emergency` (a11ign/a11ign#5032, the chairman's ruling of 2026-10-11: only the chairman sets priority, except in an emergency where the org is blocked). It is OFF
unless the host declaration carries `emergencyPriority: { "enabled": true }`, so no host changes behaviour on upgrade. When on, the label is honoured only while all of these hold, each read from the tracker on
every tick and none from the label: its newest `labeled` event names the managers App or the leads login, and the row's body carries an `Incident: <ref>` line naming an OPEN item labelled `incident` whose own
`Incident:` key is an org-blocking one (`incident:trunk-red`, `incident:gate-crash`, `incident:ci-permission`, `incident:claim-refusal-storm`, `incident:release-run-failed`; replaceable with
`emergencyPriority.incidentKeys`). An honoured row is offered ahead of every `priority:chairman` row, and the gate takes the label off when the incident closes. A label that does not qualify is ignored and
recorded as `emergency-priority-not-honoured`, and `ceo` is told; an agent's `priority:chairman` is still ignored and recorded as before. Each honoured use is one `emergency-priority-used` failure-ledger line,
and `messaging:watch` announces it once to the chairman's channel with the row, the incident and `ceo`'s `Emergency-reason:` line. A history or incident that cannot be read fails closed: not honoured, and the
label is not removed.
