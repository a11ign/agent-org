---
"agent-org": patch
---

The Runs board marks the critical path of the runs its blockers join, such as a planned batch's: each run on the longest chain still to finish says "On the critical path: A11-500 → A11-501 → A11-502", so a person can see which tickets decide when the batch finishes (A11-442, step 2 of 2). A run with no blocker and nothing waiting on it is on no path, a Completed, Cancelled or Checked run drops off it, and a run on a cycle of blockers is left to the cycle's own note. The line comes after the run's own lines, so a clamped row keeps its reason.
