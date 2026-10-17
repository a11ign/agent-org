---
"agent-org": patch
---

The retrospective's "Lead time, next to latest" no longer counts a version that `latest` has overtaken as a wait (a11ign/agent-org#1669). A version never promoted was counted at its current age even after `latest` had moved past it, so the median and max grew with the calendar. Such a version is now `superseded`: counted apart, and out of the median, the max and the waiting count. Only a version newer than `latest`, in version order, is still waiting. The reading prints the superseded count after the UNPROMOTED clause.
