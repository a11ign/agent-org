---
"agent-org": minor
---

The next run of a ticket accounts for the work its closed pull requests held (A11-249, step 2). A plan's brief, a batch plan's brief and the worker's brief now carry a "Work from closed pull requests" section that names the list the board kept for each pull request closed without merging. The plan must carry a `## Work from closed pull requests` section with a bullet for each commit (by SHA, at least seven characters) and each file (by path, or by a directory above it) saying `carried over` and where, or `dropped` and why; a plan that leaves one out is refused with the items it misses, and a pull request that held nothing asks for no account. The reviewer contract is 1.9: `ReviewBrief.closedWork` is the list, one line per commit and file, and the atomic reviewer's first-review prompt makes each item the pull request body's section leaves out, and each `carried over` the diff does not show, a finding.
