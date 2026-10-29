---
"agent-org": patch
---

The board asks the arm bot to arm a pull request again after a merge-queue removal the change did not cause when only the board's reviewer approved its head. The merge queue's reading of "approved at this head" counts the reviewer's verdict (`verdictAtHead`) beside `approvedAtHead`, which still leaves the reviewer out, so the reviewer's comments and reviews are still not read as feedback for the worker, and `pullAnswer` still reads "Approved" only for a person. A newest verdict that asks for changes, the reviewer's included, and GitHub's review decision still refuse it. a11ign/agent-org#2006 and #2008 were approved only by the reviewer, removed from the queue, and never armed again (A11-397).
