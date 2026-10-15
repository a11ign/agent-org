---
"@a11ign/agent-org": patch
---

A refused issue read in the claim now says why `gh` failed, on the refusal's first line and so in its `claim-refused` failure-ledger line: `could not read issue #N from <repo> -- refusing to guess whether it is claimed (gh said: <gh's first stderr line>). …`. Before, the cause was on the second line, which the ledger never kept, so a rate limit, a missing issue and a 401 all read the same (a11ign/a11ign#5282, agent-org#1246). With gh silent the line reads as before.
