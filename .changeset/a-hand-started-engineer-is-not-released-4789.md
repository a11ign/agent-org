---
"agent-org": patch
---

A merged pull request counts as a claim's landed work only if it merged after the holder's `session:<name>` label was added, as well as after the newest claim record. A hand start adds the label and writes no record, so the newest record was the previous holder's and its merged pull request released the new engineer minutes after its start (a11ign/a11ign#4524, agent-org#562). The gate reads the label's `labeled` event through the new `HostReads.labelEvents` seam, only for a claim that has a merged pull request to judge; a label time it cannot read holds the claim with the reason in the log line and never releases it. A claim made by `row-claim` and a merge after the label release as before. a11ign/a11ign#4789.
