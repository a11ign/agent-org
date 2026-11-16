---
"agent-org": minor
---

`tickets.lessons` is now on by default (A11-432, step 3 of 3). The worker eval ran its first set with lessons off and on at the same commit. On the 6 tickets both runs worked, the reviewer was convinced by 5 with lessons on and 3 with them off, and the tests column was the same. So the board now runs the daily retro and worker and planner briefs carry their repository's lessons unless the host file sets `tickets.lessons` to false. The retro's model is now told never to write or keep a lesson that asks a worker to merge a pull request, enable auto-merge, mark it ready, request a review, force-push or push to main. The worker eval accepts `--key tickets.lessons=on|off` and carries the host's lessons into its worker's brief. A worker that fails in the eval now says why in its note (its result's error, such as a usage limit, or its first stderr line), and its output is kept in `record/worker-failed.txt`.
