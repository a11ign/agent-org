---
"agent-org": patch
---

The board-truth audit no longer raises the row of record as the duplicate. `duplicateOf` accepted a twin when it was closed OR lower-numbered, so an open row with a CLOSED row filed after it (the usual shape: the later row is the duplicate and was closed) was asked to resolve a pair already resolved. A twin now counts only when its number is lower than the row's, open or closed; the later row is raised when IT is open. Seen 2026-10-09: #4535/#4537/#4539/#4541 against #4536/#4538/#4540/#4542, and #4623 against the closed class row #4624, whose order to `product-manager` sat deferred ("is working") for over an hour. a11ign/agent-org#507.
