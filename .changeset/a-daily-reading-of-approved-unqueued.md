---
"@a11ign/agent-org": minor
---

The work-gate tick now posts, once per UTC day on #928, a reading of the approved pull requests left unqueued for more than 15 minutes (each with its reason: `draft`, `hold`, `failing check` or `not armed`) and the p90 of approval-to-queue over the last 40 merged pull requests per repository against 5 minutes. A count above 0 on two consecutive days records one `approved-unqueued` incident in the failure ledger. The reading is read-only apart from its own keyed comment, and `node src/approved-unqueued.ts --dry-run` prints today's reading without posting.
