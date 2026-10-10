---
"agent-org": minor
---

`pr-review-blocked` no longer orders anyone for a pull request whose only blocking review was posted at an older head than the current one. `withStaleRefusals` (`src/work-gate.ts`) compares each `CHANGES_REQUESTED` review's `commit.oid` with `headRefOid` (a commit that is unnamed, or whose patch is known to equal the head's, keeps the order) and stamps the pull request; `reviewBlocked` leaves a stamped pull request out, and the gate records it once on the pull request through `TicketPort.postDecision`, a record it cannot post leaving the order as it was. A refusal at the current head is ordered as before: to the owner session when the pull request carries a labelled one, to `product-manager` when it is unowned. `reviewer-<n>` is still asked for a verdict at the new head by `draft-awaiting-verdict`. `A11IGN_PR_REVIEW_BLOCKED_BY_GATE=off` in the tick's environment restores today's order, with no write. a11ign/agent-org#489.
