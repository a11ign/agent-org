---
"agent-org": patch
---

The outside arming pass reads a pull request back after a NONZERO `arm-pr` exit too, and reports what GitHub says (a11ign/agent-org#1626). `arm-pr` exits 1 (the retired-session label refusal), 3 (ARMED_THEN_LABEL_FAILED) and 4 (JUMP_UNCONFIRMED) after its arm write, so the pull request can be armed while the pass logged `COULD NOT ARM`. Now a read-back that shows it armed is `armed` and logs `OUTSIDE-ARM: #n armed -- read back: <reason>. BUT arm-pr exited <code> (<last line arm-pr said>)`; a nonzero exit whose read-back shows nothing armed (exit 1 for authorship, before any write) is `failed` as `COULD NOT ARM -- arm-pr exited <code> (...); read back: NOT ARMED`; a read-back that throws is `failed` and names the exit. `src/arm-pr.ts` and its exit codes are unchanged.
