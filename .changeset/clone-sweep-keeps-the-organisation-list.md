---
"agent-org": patch
---

The board's clone sweep reuses the organisation's repository list for 15 minutes instead of running `gh repo list` on every pass (A11-377). Each pass held the board's loop for about 1.5 s. On v0.331.4 that was every held-loop line, 6 in 20 minutes, at `repositories.ts:55`. A plan or a worker that names a repository still reads the list fresh.
