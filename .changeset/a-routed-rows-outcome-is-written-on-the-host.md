---
"@a11ign/agent-org": patch
---

A routed row's outcome is now written to the decision log by the gate, on the host (a11ign/agent-org#752, a follow-up to #687 and a11ign#4756). Each tick, once herdr's listing is complete, a routed row that has closed and has no outcome gets `merged-first-pass`, `not-first-pass`, `escalated` or `closed-without-merge` through `recordClosedRow`, once per row. The close script cannot do it: it runs on a GitHub runner that has no decision log. The pull request's merge and review rejections are read from the trace store (`pullOutcome`, the definition the stop rule and `route-guard.ts` use), a pull request the store has not reached yet is held and never written as unmerged, and a read that fails writes nothing and says so.
