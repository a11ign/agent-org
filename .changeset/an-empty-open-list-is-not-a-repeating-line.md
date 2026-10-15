---
"@a11ign/agent-org": patch
---

`readPrs` no longer writes `work-gate: the open list is read whole (too-old: ...)` for a repository whose open list is EMPTY. An empty list is never remembered (the first-wave rehearsal answers `[]` to every call), so a repository that went empty kept its old entry, which aged past the reconcile and logged the line on every tick for as long as it stayed empty: 60 consecutive ticks on 2026-10-13 while a11ign/a11ign had no open pull request (05:27Z to 07:47Z), which `repeating-lines` rightly reported as a defect. The read is unchanged (it was always the whole one); only the line, which is now written after it and only for a list that is not empty or a read that was refused. a11ign/agent-org#1300; the digest of 2026-10-13T07:50Z.
