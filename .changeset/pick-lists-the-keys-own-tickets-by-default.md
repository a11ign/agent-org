---
"agent-org": patch
---

The Pick view opens on the key's own open tickets again when `tickets.pick` is absent or `"assigned"`, and still reaches everyone else's. A11-108 had made that default read every open ticket the key can see, so the page could filter it by assignee. On a workspace of NetBox Labs' size that list is 19 MB and takes 53 seconds, past the page's 30 second and 8 MB limits, so the board showed no tickets and no queue and said it could not reach the instance. The instance now answers `/api/people`, a small read of who holds the open tickets, which the Assignee row counts from, and `/api/tickets?assignee=<person, unassigned or anyone>`, which reads one scope a page at a time. The page reads another person's tickets, Unassigned or Anyone only when it is chosen, and each page joins the list as it arrives. A team or a project in `tickets.pick` still lists every open ticket of it at once. A board on an older instance reads as before.
