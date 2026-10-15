---
"agent-org": patch
---

A closed row whose claim labels were left on it by its own merged pull request is released by the claim-stall tick, and the line saying so is written once per stand, not once per tick (a11ign/agent-org#1463, #1325). No merge settle clears an agent-org row's claim labels, because the close-rows sweep runs in the host repository's CI and was never copied here; the release now happens in the gate's closed-row read, which keeps its memory of the line in `closed-claim-lines.json` under the state directory.
