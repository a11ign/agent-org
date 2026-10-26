---
"agent-org": patch
---

A pull request the merge queue removed is put back in the queue by the board instead of sitting approved and unarmed. When every job that failed in the removal's `merge_group` run failed before the code ran (an install or registry error such as `ETARGET` or a 5xx, a lost runner, a job that could not be set up) and the pull request is still approved at the same head, the board asks the arm bot to arm it again and starts no worker round, at most twice for a head; the third removal starts a round as before. A worker round for a removal that ends with no push puts the pull request back in the queue too, and the log says why it was not in the queue. A round for a removal is told to push nothing when nothing in the change causes it (A11-295).
