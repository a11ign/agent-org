---
"agent-org": patch
---

With the machinery flag `prs.ownerRouting` on (default OFF), an outside pull request that has not been updated for 7 days files one triage row (labelled `outside-pr-idle`, boarded in the Backlog) and wakes no session. A second tick files nothing for the same idle episode. With the flag off nothing is filed.
