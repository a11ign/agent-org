---
"@a11ign/agent-org": patch
---

With the machinery flag `prs.ownerRouting` on (default OFF), a dependency bot's pull request (Dependabot or Renovate) that goes red, conflicts or gets a not-convinced verdict is ordered to a worker, not to `ceo`, and `ceo` is not woken for it. Its other follow-ups stay withheld as before. The flag is off by default, and with it off every order is as it was (agent-org#1368).
