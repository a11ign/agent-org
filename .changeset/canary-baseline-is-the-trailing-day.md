---
"agent-org": patch
---

The machinery canary's bar is built from the higher of the hour before a flag and the trailing day's hourly mean, so one quiet hour no longer sets the bar at the org's base rate and reverts a flag that never touches a claim (a11ign/agent-org#1424, a11ign#5444). A day less than half recorded is not a baseline, and the rule is unchanged for it.
