---
"agent-org": patch
---

The machinery-flag ledger no longer calls a canary-homed flag without a switch row when that row is in another declared tracker: a `ready` or `in-progress` row naming the flag in a non-home tracker now clears it, and a tracker whose read is refused makes the answer unknown rather than clean. `src/flag-switch-ledger.ts`. agent-org#1372.
