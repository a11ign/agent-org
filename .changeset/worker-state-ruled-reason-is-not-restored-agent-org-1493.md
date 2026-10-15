---
"agent-org": patch
---

`worker:state blocked` no longer puts the answer label back on a row a manager has already ruled on. When the reason is one a manager (orchestrator, product-manager or ceo) has ruled on since the worker's last `BLOCKED` comment with that same reason, the declaration writes neither the `answer:<session>` label nor a second comment: it prints one line naming the ruling comment and its time, and exits 0. A different reason is declared as before, and so is a repeat no manager has answered. The same holds when the worker's stop hook makes the declaration at its bound. Before, a repeat restored the label on a row nothing was owed on (a11ign/agent-org#1493).
