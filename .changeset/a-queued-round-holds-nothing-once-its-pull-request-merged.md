---
"agent-org": patch
---

A queued review round no longer holds the files of a pull request that merged or closed: the watch reads the state of every pull request a queued round names, one that merged or closed leaves the round, and a round left with none is dropped so the ticket is completed or queued for its next step (a11ign/agent-org A11-298, which held every announcement-emulator ticket for 30 hours). A review round on an open pull request starts whatever its ticket's blockers are. A wait cycle through a files hold is told once and says the board lifted the hold. A queued run that has waited more than 2 hours on the same ticket is listed on the Runs page and by `doctor`, with what it waits on and whether that ticket can move.
