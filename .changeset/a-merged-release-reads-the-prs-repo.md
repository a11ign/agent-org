---
"agent-org": patch
---

A claim whose pull request merged in another tracked repository is released as merged only after the holder's worktrees in THAT repository's clone were read: one with a dirty file or a commit on no remote is held, and an unlisted clone or a failed `git worktree list` refuses the release, in the gate's reading and in the performer's own re-read (a11ign/a11ign#3453)
