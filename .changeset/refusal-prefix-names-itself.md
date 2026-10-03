---
"agent-org": patch
---

A refused chairman alert is logged as `alert not sent: …`, no longer under the `chairman-options:` prefix: `messaging:watch` prefixed every request problem with it, so the refusal added in #122 was filed under the name of the malformed options block and a grep for options problems found refusals too. A request problem now names itself where it is made (`requestEvent`), and the watcher adds nothing. A malformed options block is still logged as `chairman-options: …`, and the ledger's note carries the same text.
