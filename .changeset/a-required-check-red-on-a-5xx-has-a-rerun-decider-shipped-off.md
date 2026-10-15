---
"@a11ign/agent-org": patch
---

A required check that went red on a GitHub 5xx now has a decider for a single rerun, in `src/ci-rerun-on-5xx.ts`. It is shipped OFF (`ci.rerunOn5xx`), so nothing changes until the switch is turned on. With the switch on, a failed job whose last error line is a GitHub 5xx and whose head has had no rerun is answered `rerun`; every other case is answered `owner`, as today. The rerun itself is not made yet: it goes through the ticket port in a follow-up (agent-org#1180, #1217, #1218).
