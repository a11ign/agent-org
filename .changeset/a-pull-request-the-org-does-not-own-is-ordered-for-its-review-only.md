---
"agent-org": patch
---

With the machinery flag `prs.ownerRouting` on (default OFF), a pull request the org does not own (review trust OUTSIDE, or authored by the chairman) keeps only the orders that ask a reviewer for a verdict. Its red checks, conflict, not-convinced verdict and changes-requested no longer wake a session. The flag is off by default, and with it off every order is as it was (agent-org#1325).
