---
"@a11ign/agent-org": patch
---

The org-health lab-jobs test no longer reads the host's claim-refusal ledger or its declared copies, so a busy host or a drifted checkout cannot fail it. `orgHealthNow` takes an optional `readRefusals` and forwards it to `orgHealthTick` only when a caller supplies one; production still reads the failure ledger by default, so no behaviour changes outside the test. a11ign/a11ign#5157.
