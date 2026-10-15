---
"agent-org": patch
---

A gate tick whose only unread lanes were skipped BY DESIGN (`gate.graphqlPacing` below the pool's reserve, or a webhook tick no event named a repository on) now exits `PACED` (4) and says `N lane(s) skipped by pacing, none refused`, where it exited `PARTIAL` and the tick logged `one lane could not be read` on every tick: 663 consecutive ticks read as a fault that never clears (agent-org#1414). A refused lane, with or without paced ones beside it, is still `PARTIAL` with the old wording. The all-paced lines are in `src/repeating-lines.allowlist.json`; the refused ones are not.
