---
"@a11ign/agent-org": patch
---

A red check's class is read from its failing assertions, behind `CI_CLASS.assertionsOnly`, which ships OFF. A passing test that prints "rate limit" or "502" beside a real failure is no longer classed as infrastructure once the flag is on: the rate-limit and lost-runner text is read from the failing assertion lines when one is named, and from the whole log when none is, so a runner lost before any assertion ran is still infrastructure (a11ign/agent-org#1166).
