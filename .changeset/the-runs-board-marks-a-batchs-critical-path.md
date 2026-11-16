---
"agent-org": patch
---

The Runs board marks the critical path of the runs its blockers join, such as a planned batch's: each run on the longest chain still to finish says "On the critical path: A11-500 → A11-501 → A11-502", so a person can see which tickets decide when the batch finishes (A11-442, step 2 of 2). A run with no blocker and nothing waiting on it is on no path, and a Completed or Cancelled run drops off it.
