---
"agent-org": patch
---

The test for an unreadable deferral record no longer fails under a long `TMPDIR` (a11ign/a11ign#3792). The log line keeps the first 160 characters of the error, which names the record's path before what was wrong with it, so an agent session's scratchpad cut the assertion's text away. The test now gives the ledger as a relative path from inside its directory, so the path the message names is `./wake-deferred` whatever `TMPDIR` is. Test only: `wake.mjs` is unchanged.
