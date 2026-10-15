---
"@a11ign/agent-org": patch
---

The tick reruns a required check that went red on a GitHub 5xx once, through the ticket port, and writes one `checks rerun on 5xx` line per rerun to `ci-reruns-on-5xx` beside the delivery ledger. Ships OFF (`CI_RERUN_ON_5XX.enabled`); with it off the tick is unchanged.
