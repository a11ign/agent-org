---
"@a11ign/agent-org": patch
---

The closed-claim read goes over REST, so an exhausted GraphQL pool no longer leaves a closed row's claim unread (a11ign/agent-org#1113). `readClosedClaimedRows` reads each listed row with `issues/<n>`, and for a closed row still carrying the claim label, its last 100 comments, its timeline's cross-referencing pull requests (at most five) and each one's head (`pulls/<n>`). It answers the same shape as before: the keyed rows with their tracker tag, `null` on a refusal (never an empty list), and an HTTP 404 on the issue as an absent row. A refusal on any of those reads still makes the read UNREAD and names its cause on the log.
