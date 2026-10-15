---
"@a11ign/agent-org": patch
---

The claim path reads its row over REST (`gh api repos/<repo>/issues/<n>`, and the comments as `--paginate --slurp`, the last 100 kept) instead of `gh issue view`, which is GraphQL. An exhausted GraphQL pool no longer refuses every claim, because the core REST pool is separate. A REST `state` is lower case and is mapped to the `OPEN`/`CLOSED` the claim reads; a failed or non-JSON answer still throws and refuses, as it did before. A rate-limited refusal names its cause on the ledger line (`api-pool-exhausted; gh said: ...`), and still counts as guard-held. agent-org#1302.
