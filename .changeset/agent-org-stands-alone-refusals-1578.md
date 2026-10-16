---
"agent-org": minor
---

The outside home of a project's deliberate refusals, behind the flag `outside.refusals` in a project's `.agent-org/decisions.json` (absent = off, shipped OFF; agent-org#1578, the epic "agent-org stands alone"). ON is shadow: for each open, same-repository pull request by an org identity whose `deliberateRefusals` job has settled at its head, the host gate asks the verdict the arming doors already ask (`deliberateRefusalVerdict`, the job's own `merge-guard` and `closes-mismatch-check` verdicts) and appends it, beside the job's, to `outside-refusals-shadow.jsonl` in the gate's state directory (`settleOutsideRefusals`, called in `readArmingOf`). It holds, labels and refuses nothing, and a head already recorded is not asked again. The project's job stays in `gate`'s `needs`.
