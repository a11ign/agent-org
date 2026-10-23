---
"agent-org": patch
---

The reviewer starts once the checks the base branch REQUIRES have settled green, and a failing check that is not required no longer holds it: the GitHub plugin reads which checks are required (`isRequired`, from the branch's rules and rulesets) when the checks are not all green, and the reviewer's brief names the checks left red. A multi-step ticket's run holds only its current step's paths (the `### Step <N> of <M>` section of its plan) and its open pull requests' files, not the whole plan's, and a queued later step contests only its own step's paths. A pull request whose body says `Partial: step N of M` is reviewed against that step's section of the plan and the ratchets' direction, with the ticket's Done-when named as the last step's. The code host contract is 1.6 (`ReviewState.unrequiredRed`) and the reviewer contract is 1.3 (`ReviewBrief.step`).
