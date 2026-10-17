---
"agent-org": minor
---

A failed App-token mint no longer sends an authoring call (`pr create`, `pr merge`, `pr review`) as the shared account when the flag `gh.refuseFallbackAuthor` is ON. The wrapper mints again, a bounded number of times (`A11Y_APP_AUTHOR_MINTS`, default 3), and when every mint fails it REFUSES the call: non-zero, nothing sent, the reason on stderr, and one incident line per mint in the ledger. Reads still fall back to the account. The flag is OFF when absent, so nothing changes until it is switched on. A new health signal, `gh-author-fallback`, counts account-attributed authoring calls in the ledgers within the last ten minutes and reads unread (not zero) when the ledgers cannot be read (agent-org#1666).
