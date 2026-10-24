---
"agent-org": patch
---

The board shows Ready to merge only when every open pull request of a run is approved at its current head and its required checks are green there; a run whose feedback round ended `reviewed` and is not there yet reads Awaiting review and says what it waits on (review: none yet, checks red, checks running). A check that fails on the default branch too, or on another run's pull request that touches none of the run's files, starts no fix round and is named on the card as red on main / not this run's, with the ticket that owns it. The code host contract is 1.13.
