---
"agent-org": patch
---

The gate reads each other repository's open pull-request list once a tick, not twice. `readOtherScopes` read it for the lanes and `readElsewherePrs` read it again for the claim-stall facts; the second now takes the first's list (a refusal stays a refusal). Measured by the census: 5 of 53 `gh` calls, about 4.6 s of a 34 s gate. The tick-cost line also carries `ghRepos`, the `gh` reads and their wall per repository, and a census record names the `GH_REPO` a `gh` call was aimed at. a11ign/a11ign#3566, slice 2 of the tick's cost.
