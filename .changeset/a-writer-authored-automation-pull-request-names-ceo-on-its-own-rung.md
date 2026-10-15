---
"@a11ign/agent-org": patch
---

`ownerOfPr` gains an `automation-writer` rung after `owner-gone` and before `chairman-author`: a pull request the writer app (`octo-sts`) opened on an `automation/` branch, with no live session label, no row owner, no branch owner and no stamp, names `ceo` with `source: "automation-writer"` instead of falling off the ladder, so `owner-unresolved` stops recording a correct address as "nobody could be named" (a11ign/a11ign#5210 and #5283). It reads the writer's login in all three spellings (`octo-sts`, `app/octo-sts`, `octo-sts[bot]`) and the `automation/` branch prefix; a worker account's pull request on an `automation/` branch and the writer's pull request on any other branch still reach `ceo`'s last rung and are still recorded. The stalled, conflicted, verify, remedy and not-convinced orders say "the writer app opened it" for it, not "its label names you". a11ign/agent-org#1239.
