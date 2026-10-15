---
"@a11ign/agent-org": patch
---

The `row-call-count-signal` wake cause has a decision class (a11ign/agent-org#908, Move 3 of a11ign/a11ign#4505): `src/decision-run/classes/row-call-count-signal.ts` asks "one unit, or split?" with `one-unit` as the default, posts a `one-unit` verdict in the shape `formatRowCallCountAssessment` writes, and hands `split` and `escalate` back to the standing seat. Nothing changes until a project's `seats.json` sets the cause to `run`; the class is `seat` by default and that one line is its revert.
