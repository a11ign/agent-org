---
"agent-org": patch
---

A pull request the merge queue removes for a test that passes on rerun is no longer left out of the queue until a push that never comes (agent-org#1983, A11-371). The first removal for a job the code failed reruns the failed jobs of the `merge_group` run behind it and asks no worker; the card says "ejected from the merge queue: <job>, retrying". When the rerun passes, the failing test is written to the flake log (A11-300) and the arm bot is asked to arm the pull request again, once for the head. When the rerun fails again, has not concluded after 30 minutes, or the pull request is removed again at the same head, the failure goes to the run as a round that quotes the failing test, and the card says "sent to the run". Nothing is rerun when the code host cannot read a run's conclusion, the pull request would not be armed after a pass (not approved at its head, in conflict, held, or its re-arms spent), or the host refuses the rerun: the round starts as before.
