---
"agent-org": patch
---

The readiness score's offline test (A11-443, step 2 of 2). `node scripts/check-readiness.ts` scores past tickets with the board's own scorer and sets each score against how the ticket's runs went: rounds per run and Needs-you rounds from the outcome records, and re-plans from the run log. Over the 10 tickets whose first recorded run is oldest it found no clear link: the stored run scored all 10 between 62 and 78, so no ticket scored low, and none of them had a re-plan or a Needs-you round. `tickets.readiness` stays off by default, and a test now holds that default to the stored result in `evals/readiness/result.json`.
