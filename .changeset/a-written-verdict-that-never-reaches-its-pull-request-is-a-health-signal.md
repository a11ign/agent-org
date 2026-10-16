---
"agent-org": patch
---

An outside reviewer's written verdict that never reaches its pull request is now a health signal, `verdict-written-undelivered`, and so is a conflicting pull request whose worker is idle, `conflicting-pr-worker-idle` (a11ign/agent-org#1649). Both trip at 15 minutes. The drop was in the reader: Codex puts a `• ` bullet before the first line of a final message, the strict reader rejected `• BEGIN REVIEW VERDICT`, the door was never called, and a11ign/agent-org#1615 had no review. `reviews.verdictDelivery` ships OFF; ON, the gate reads the bulleted block and posts it, and both signals read nothing while it is OFF.
