---
"@a11ign/agent-org": patch
---

A refusal that is the claim guard working (the worktree cap, a B4 overlap, a tree or branch that already exists, and a read the rate limit refused) is now written to the failure ledger as `claim-guard-held`, not `claim-refused`. `class-repeat` counts it as no class and no repeat, so it no longer trips `class-repeat` on a claim-refusal storm. The failures of the claim path (an unreadable read, B4 not askable, a rule copy behind the release, an unknown tracker key) stay `claim-refused`, with the cause on the line. Signal 26 still reads both kinds. a11ign/a11ign#5282.
