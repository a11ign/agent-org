---
"agent-org": patch
---

A run that ended `needs-human` because of something about its pull request no longer stays at Needs you once that pull request has merged. The board closes the run's parked workspace, then does what it does for any run whose pull request merged: a `Partial: step N of M` merge queues step N + 1, and a `Closes` merge completes the ticket. The card says `the blocker cleared: a11ign/agent-org #1885 merged` (and `…; step 2 of 2 queued` for the next step), with the question the run asked still one click away. A `needs-human` run that holds no pull request but names one in its reason, which the tracker links to the ticket and reads open, waits on that pull request; one that names a pull request already merged when first read, or none, is left alone, as is any other kind of hand-back. A workspace herdr will not close stays parked, and the next refresh tries again.
