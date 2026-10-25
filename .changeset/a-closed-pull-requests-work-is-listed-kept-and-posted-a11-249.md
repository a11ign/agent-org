---
"agent-org": minor
---

The work a pull request holds when it is closed without merging is listed, kept and posted on its ticket (A11-249). The board's tracker refresh now looks at every run that holds a pull request, in any phase, and for each one the tracker names closed it asks the code host (contract 1.20, the optional `readClosedWork`, read from the compare of the base with the head commit) for the commits not on its base and the files they change. The list is written under the ticket's folder (`closed-pulls/<owner>-<repo>-<n>.md` and `.json`) and posted on the ticket as "Closed pull request #N: work not on <base>", with the branch, the head and every commit's full SHA. A pull request whose commits are all on its base is recorded as "no unique work". The flow never deletes the branch. The next run's brief and the plan check follow in step 2.
