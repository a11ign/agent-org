---
"agent-org": patch
---

The verdict parser reads a hyphen-joined refusal as a refusal: `not-convinced`, `Not-Convinced` and `not-yet-convinced` used to match only the bare `convinced` (the `not\s+` in the word pattern needed whitespace), so a reviewer's `not-convinced` was read as an approval (agent-org#1659, found in agent-org#1649). The spaced forms, the bare `convinced`, the `un-?convinced` arm and the three-word bound are unchanged.
