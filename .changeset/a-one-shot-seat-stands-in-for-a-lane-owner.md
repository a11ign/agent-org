---
"@a11ign/agent-org": patch
---

`laneReason` learns that a one-shot seat is the lane owner for the one row it was spawned for (a11ign/agent-org#947, `ceo`'s ruling B). The fact is a record of a spawn (`src/row-claim/lane-stand-in.ts`: seat, row, owner, `writtenAt`), honoured only for exactly that triple, for 24 hours, and while the row is open; a roster field or a name pattern was refused because it would let every spawned engineer claim every `lane:orchestrator` row. `decideClaim` reads the records at its two claim call sites and passes them to `laneReason`, which takes them as an injected dependency defaulting to none, so the merge guard's call and every row with no record are unchanged. `ROUTED_TO`, `FLEET_LAB_PATTERNS` and `fleetOrLabAcceptance` are untouched. Nothing writes a record yet: the spawn-side writer call is #832's, so the rule is inert until then.
