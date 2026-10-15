---
"@a11ign/agent-org": patch
---

The gate says, once, to `product-manager`, when an open pull request's `Closes` names a row that is no longer on its tracker's open list, so a row closed by another repository's merge while this half is unmerged is no longer silent, behind the `rows.closedUnderOpenHalf` flag (default off). `src/work-gate.ts`: `rowsClosedUnderOpenHalf` (pure, from the lists the tick already holds, a refused or cut list says nothing), `closedUnderHalfOrders` (the order and its once-only record). It cannot reopen the row: the ticket port has no such operation (ADR 0046). a11ign/a11ign#5125.
