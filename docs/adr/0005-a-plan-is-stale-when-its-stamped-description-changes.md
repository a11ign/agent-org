# A plan is stale when the description it was stamped with changes

## Context

A ticket's description can change after it is queued or planned: A11-166 gained a replay method and a cookie-dialog rule while it waited, and A11-144, A11-145 and A11-149 had their Done-when lines corrected. A plan written before such an edit was worked as though it still held, and nothing recorded which text it was written against.

## Decision

When the board attaches a planning run's plan, it writes a `## Planned against` section into the plan file, just before `## Paths`. The section holds the ticket's `updatedAt`, the sha256 of its description, the files attached with the plan, and the description itself. A queued run whose ticket's description no longer has that hash is re-planned before it starts. The stale plan is detached first, along with the files its stamp lists, and the planner gets a copy of it.

We compare the description's hash rather than `updatedAt` because the tracker moves `updatedAt` on every state move and attachment the board itself makes. The board writes the stamp, rather than the planner, so the stamp is exact. The stamp lives in the tracker, rather than in one instance's queue, so any instance can check it and show the old text. A plan with no stamp, such as one a person attached, is never re-planned, because nothing records the text it was written against.

## Considered options

- **Compare `updatedAt`:** rejected, because the board's own writes would re-plan every ticket.
- **Keep the record only on the queue entry:** rejected, because a plan from another instance, or one that outlives a queue, could then not be checked or shown as a diff.
- **Have the planner write the hash:** rejected, because an agent copying a 64-character hash is not reliable, and the board has the exact read.

## Consequences

- The tracker contract gains the optional `updatedAt` of a ticket, `texts` and `detachPlan` (1.3), and the code host contract the optional `readMergedFindings` (1.4). A tracker without them never marks a plan stale and cannot re-plan.
- The description is quoted inside the stamp, line by line, so a heading in it is never read as the plan's own (`## Paths`, `## Decisions made without a person`).
- A plan whose blockers' pull requests merged after it was written is planned again too, because it cannot say how their findings apply; the plan's `## What the blockers found` section names the pull requests it covers. The planning brief lists every blocker and each pull request of it, and marks the merged ones whose findings the board read as needing a line; the planner's Stop hook checks the plan against that list before the planner ends, and sends it back once, in its own session, naming what it misses (A11-207). The board's check at settle is still the authority: a second miss goes to Needs you, and the card says the one automatic retry was made.
