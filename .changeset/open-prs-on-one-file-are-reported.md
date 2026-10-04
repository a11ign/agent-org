---
"agent-org": patch
---

Two or more open pull requests that change one file are reported on the tick to the owner of the later one, before either conflicts: the order tells them not to rebase or ask for a review yet, and to hold behind the one ahead (`Waiting-for: merged #m`) until it merges; a pair already held and waiting is not reported again (a11ign/a11ign#3480)
