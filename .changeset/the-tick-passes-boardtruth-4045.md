---
"agent-org": patch
---

The tick now passes `boardTruth` to `org-health` and posts one table a day on #928 (a11ign#4045, the follow-up of #4043). `orgHealthNow` builds it from the open rows the tick already read, the claimed rows' comments page and the wait facts its own wait pass built (so `wait-already-true` is read, not `NOT READ`); a refused open-row read is `null` (unknown), and a caller that gives no `readBoardTruth` gets no reading, as for the other optional facts. `boardTruthNow` adds the closed rows, the merged pull requests and the herdr listing (two `gh` list calls a tick, the closed rows without bodies) and `postDaysTable` comments `boardTruthTable` on #928 once per London edition day: the record is asked first (a `since=` page of comments) and a heading already there posts nothing. Only a complete reading is posted, since a day's table cannot be replaced; a failed ask or post is said on stderr and never stops the tick.
