---
"@a11ign/agent-org": patch
---

Every refused claim is now one `claim-refused` line of the failure ledger (agent-org#972), so the claim-refusal storm signal (agent-org#889) has something to read. Each `NOT CLAIMED:` or `COULD NOT DETERMINE:` exit of `row-claim` appends the refusal's first line as the reason, and the verdict and exit code do not change. A ledger that cannot be written is said on stderr and the claim still stands. `CLAIM_REFUSED_KIND` moves to `failure-ledger.ts` so the recorder and the reader name it from the same leaf; `org-health.ts` still re-exports it.
