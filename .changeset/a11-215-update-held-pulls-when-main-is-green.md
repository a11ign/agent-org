---
"agent-org": minor
---

When main goes green again, the board brings each pull request it held as "red on main / not this run's" up to date with main, through the code host's update-branch and the workers' identity, with no worker turn, so their checks run again and the card says "main is green again: updated from main". The board now records which main check a held pull request waits on, and updates it only when main's head reports every check it is red on as passing: a failed read of main, or a check still running there, keeps the hold. A pull request with a red check of its own is not updated by this rule, a pull request that conflicts gets the existing conflict round, and one the host refuses is asked again on the next watch. The code host contract is 1.15: `DefaultBranchRed` gains an optional `passing`, and the base contract an optional `updateBranch`, which `plugins/github` implements as `PUT .../pulls/{n}/update-branch` with `expected_head_sha`.
