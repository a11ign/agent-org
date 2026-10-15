---
"@a11ign/agent-org": patch
---

The red-check class is now read from the failing assertions by default (`CI_CLASS.assertionsOnly` ships ON, a11ign/agent-org#1166 behind the switch row a11ign#5216). A passing test that prints "rate limit" or "502" beside a real failure is `own-defect`, routed to its owner, not `infrastructure`. A runner lost before any assertion ran is still `infrastructure`. `readCiFailure`'s `flags` argument takes `{ assertionsOnly: false }` for the whole-log read the classifier had before.
