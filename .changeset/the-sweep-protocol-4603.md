---
"agent-org": minor
---

A row that declares a `Sweep:` runs under the sweep protocol (`src/sweep-window.ts`): while it is claimed `row-claim` refuses any other claim whose Region shares a file with the sweep's, naming the sweep row and the minutes left; a sweep with no pull request 15 minutes after its claim is reported stalled on the row; CI-fix time is boxed at 60 minutes from the pull request opening, after which the window is released, the overrun is recorded as `sweep-overrun` and the holder is told to revert or split; and `row-file` refuses the session holding a claimed sweep a follow-up row into the sweep's area until the merge (a11ign/a11ign#4603, lock-gridlock fix 2 of 4).
