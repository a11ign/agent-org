---
"agent-org": patch
---

The gate releases a claim whose only remaining step is a wait the holder cannot finish through, when the holder holds nothing. `clockReading` returned `waiting` for any declared wait (a future `Not-before`, `answer:<another session>`, `needs:chairman`, a `Waiting-for:` on a row) and left the claim standing, so an engineer slot and its Region were held for hours or days (`worker-3870` held #3870 for a reading due a day later). Such a claim now reads `release` with the new `why: "wait"`, by the same `workAtRisk` predicate release (8) uses for an open `blockedBy` edge: a dirty tree, an unpushed commit, an unreadable tree or an open pull request keeps today's reading, and `fleet-hold` (the holder's own wait) is not released. The release comment names the wait; the row's wait field stays on it, so the gate offers it again when the wait clears. a11ign/a11ign#4637.
