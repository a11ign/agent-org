---
"@a11ign/agent-org": patch
---

A pull request from outside the org (a fork, or an author not declared by the org) is reviewed read-only: the reviewer is a read-only codex sandbox with no network, no dependency install, no command from the pull request, and no GitHub account in its environment, and the verdict is posted from outside the sandbox by the gate. A same-repository pull request by a declared identity is reviewed as before, with the same spawn arguments (agent-org#1311).
