---
"agent-org": patch
---

`host:check` no longer calls a worker on a `tier:haiku` row "SESSION ON AN UNDECLARED MODEL". `sessionModelDrift` compared every live session with `DECLARED_CLAUDE_MODELS`, which holds Sonnet only, so each Haiku-tier worker (`claude-haiku-5-5` by design) sent a `host-units-stale` order for the intended state. A `worker-<n>` session is now expected on `HAIKU_MODEL_ID` when row `n` carries `HAIKU_TIER_LABEL`: Haiku there is clean, Sonnet there is the finding (naming the row and both ids), Haiku on an unlabelled row is still a finding, and a row that cannot be read keeps the old comparison. a11ign/a11ign#4457.
