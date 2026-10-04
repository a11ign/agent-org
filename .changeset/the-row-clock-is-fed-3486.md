---
"agent-org": patch
---

The gate feeds the outcome clock the claimed rows' comments, so a claimed row past its bound is named overdue (a11ign/a11ign#3486, slice 2). `orgHealthNow` had `claimedComments` since slice 1 but the tick's call omitted it, so production clocked PRs and was silent about every claimed row. "No row is claimed" is now `[]` and a refused read of the comments stays `null`, reported as unread and never as nothing overdue. The dead `readHeadCommittedAt` and its `GH_READS.conditionalOnQuietStalledPr` entry are deleted; a Dependabot PR is a fixture of the clock.
