---
"agent-org": patch
---

A finished run now settles from its own pull requests whatever its outcome was: merged, it is Completed and its ticket is moved to done (a run declared partial keeps its ticket open); closed unmerged, it is Cancelled. A `needs-human` run whose pull request was pushed to after the run ended, or approved at its head, reads Awaiting review with "Answered: awaiting review" or "Approved" instead of its old question, which stays under "The question it asked". The pool records the head of each open pull request when a run ends and on each watch. A conflict a stacked run records with its blocker's branch clears once its pull requests are mergeable, and a card says a note once (A11-153).
