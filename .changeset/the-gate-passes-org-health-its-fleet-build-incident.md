---
"@a11ign/agent-org": patch
---

The work gate now passes org-health the open fleet build incidents, so the `fleet-build-mixed-over-4h` order to `ceo` (a11ign/agent-org#943) fires in production once an incident has stood open four hours (a11ign/agent-org#960, part of a11ign/a11ign#4405). It costs one REST call a tick (the open `incident` issues), counted in the per-tick call list.
