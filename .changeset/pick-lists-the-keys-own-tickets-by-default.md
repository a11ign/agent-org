---
"agent-org": patch
---

The Pick view lists the key's own open tickets again when `tickets.pick` is absent or `"assigned"`. A11-108 had made that default read every open ticket the key can see, so the page could filter it by assignee. On a workspace of NetBox Labs' size that list is 19 MB and takes 53 seconds, past the page's 30 second and 8 MB limits, so the board showed no tickets and no queue and said it could not reach the instance. A team or a project in `tickets.pick` still lists every open ticket of it, each with its assignee, so the Assignee filter still works there.
