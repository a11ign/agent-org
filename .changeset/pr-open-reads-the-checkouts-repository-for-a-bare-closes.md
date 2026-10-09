---
"agent-org": patch
---

`pr:open` refuses a bare `Closes #N` in a layer repository's PR opened without `--repo` (a11ign/a11ign#4469, split from #4401). `checkRegion` read the PR's repository from the flag alone and fell back to the tracker, so lab#39's `Closes: #4305, #4372` passed from a lab checkout and B4 shelved #4372 for 71 ticks. With `--repo` absent it now reads the checkout's `origin` (the read `repoFlagHint` already made, now one `originRepoOf`) for the bare-number test only; the tree the Region is read against is chosen as before. The refusal names `Closes a11ign/a11ign#<n>`.
