---
"@a11ign/agent-org": minor
---

The gate can now pace its GraphQL spend against a reserve of 1000 points, behind the machinery flag `gate.graphqlPacing` (a11ign/agent-org#1240). The flag is OFF by default, so nothing changes until `agent-org machinery:flag on gate.graphqlPacing` is run. While it is on and the pool is below the reserve, a tick skips `orgHealth` and the other repositories' lanes first, and names each skipped lane as unread, so a skip never reads as clean. On a webhook host, the other repositories are read only where the event queue names their code or tracker repository, or where their last read is 15 minutes old. The primary's claims and wakes are never skipped.
