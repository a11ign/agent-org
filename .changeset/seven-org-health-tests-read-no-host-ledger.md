---
"@a11ign/agent-org": patch
---

Six org-health tests no longer read the host's own claim-refusal ledger (agent-org#1073). `orgHealthTick` reads `readClaimRefusals()` when a caller gives no `claimRefusals`, so `org-health-auto-off-refusal`, `org-health-release-failed`, `org-health-fleet-and-copies`, `org-health`, `wait-condition` and `release-behind-main` were green on a quiet host and red, with an extra `claim-refusal-storm@<hash>` order, on one holding a storm (measured 2026-10-12: 10 failures while the ledger held 78 refusals in 15 minutes). Each now hands `claimRefusals: []` in its facts, or `readRefusals: () => []` where the call goes through `orgHealthNow` or `orgHealthTick`'s options and the readings list is asserted exactly. No source file changes.
