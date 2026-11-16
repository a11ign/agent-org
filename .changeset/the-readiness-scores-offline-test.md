---
"agent-org": patch
---

The readiness score's offline test (A11-443, step 2 of 2). `node scripts/check-readiness.ts` scores past tickets with the board's own scorer and sets each score against how the ticket's runs went: rounds per run and Needs-you rounds from the outcome records, and re-plans from the run log. Its first run, over 10 tickets, found no clear link (1 ticket scored under 60, and rounds per run 2 against 1.97), so `tickets.readiness` stays off by default. A test now holds that default to the stored result in `evals/readiness/result.json`.
