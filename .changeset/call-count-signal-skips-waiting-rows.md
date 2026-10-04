---
"agent-org": patch
---

The call-count signal leaves out a claimed row that declares a wait (`needs:chairman`, `answer:<session>`, a `blockedBy` edge, a future `Not-before:`, `parked`, `blocked`, `hold:*`), and counts a row whose wait has been lifted from the lifting rather than from the claim, so a standing seat's work elsewhere during the wait is not charged to the row. The lifting is read once, from the row's events, for a row already over the threshold, and a refused read keeps the whole window and says so on stderr (a11ign/a11ign#3384).
