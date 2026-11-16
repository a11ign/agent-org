---
"agent-org": minor
---

The board no longer ends its handling of an approved, armed pull request that sits BLOCKED behind a cancelled required check after one rerun (A11-403). Before it reruns, it asks the code host whether a run of that workflow at the head has not completed (`runsInProgress`, code host contract 4.1, optional; the GitHub plugin lists the runs at the head), and waits for the next watch if one has, because a rerun joins the workflow's concurrency group and cancels a healthy sibling run. It reruns one run for each watch and takes at most two reruns for a head (three cancelled runs). At the third, it logs one `cancelled-rerun` event with `stopped`, and the run's card says "cancelled 3 times, the board has stopped rerunning it; a new push or a rerun clears it". Step 1 of 3: the second `ci` run itself is removed by steps 2 and 3.
