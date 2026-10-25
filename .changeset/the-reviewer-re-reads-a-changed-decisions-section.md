---
"agent-org": minor
---

The reviewer now honours a person's answer written into a ticket's Decisions: when a pull request's head is blocked and its ticket's `## Decisions` change (the board wrote an answer there, or a person edited it in the tracker), the head is re-reviewed once, counted as a round, and the reviewer is told which Decisions lines changed. A reply or new description line that says a person decided something without linking the ticket is passed to the reviewer as unsupported, and the reviewer prompt says it does not answer the finding. The reviewer contract is 1.7 (`rereview.decisions`, `rereview.unsupported`, both optional); a reviewer of 1.6 ignores them.
