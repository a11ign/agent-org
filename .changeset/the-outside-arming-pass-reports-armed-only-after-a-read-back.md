---
"agent-org": patch
---

The outside arming pass reports a pull request armed only after reading it back from GitHub (a11ign/agent-org#1622). `arm-pr` exits 0 for a deliberate refusal as well as for an arm, so the pass logged "armed" for a pull request it had just ejected from the merge queue (a11ign/a11ign#1595, `autoMergeRequest: null`). Now an exit 0 is read back: an armed read is `armed`, a captured `arm-pr: NOT arming #n -- ...` line is `left` and logs `OUTSIDE-ARM: #n NOT ARMED -- <line>`, and an exit 0 with neither, or a read-back that throws, is `failed`. A nonzero exit is `failed` as `COULD NOT ARM`. Every refusal the job and `arm-pr` make is tested through the pass, and the verdict leaves a pull request whose labels were not read.
