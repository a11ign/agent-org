---
"agent-org": patch
---

A finished run the board watches whose pull request has sat changes requested at its head for more than 30 minutes with no push now gets its feedback round from the board itself, as Respond to review would start it, and no longer waits on a person (`stale-block.ts`, `pool-watch.ts`). The stale-block note on the card appears only when the board cannot start a round, and says why: a draft waits for Approve, a run that ended another way for Respond to review, a stand-off whose routes have ended for a person.
