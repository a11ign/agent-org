---
"agent-org": patch
---

The reviewer is told whether a pull request names its ticket `Refs` or `Closes` (A11-274), worked out from its plan step and the other pull requests of the run that holds it: `Refs` while it finishes a step that is not the plan's last or another of the run's pull requests is still open, `Closes` on the last to merge. Before, the reviewer judged the word by the pull request alone, and approved eight sibling pull requests with `Refs` while it blocked the ninth for the same word. The brief carries the word as `closing` (reviewer contract 1.11, optional); a pull request no run holds, a run's only pull request with no step, and one whose sibling's state cannot be read get none, and are judged as before.
