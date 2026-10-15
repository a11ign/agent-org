---
"@a11ign/agent-org": patch
---

`api-pool-low`'s Spender sentence names an App's calls. A pool whose login is `<slug>[bot]` was filtered against the ledger by that login, but `host/gh` writes an App's calls under `app:<role>`, so every App pool read "no graphql point is recorded" while the ledger held thousands (2,320 for `a11ign-scheduler[bot]` in the hour of 2026-10-10T23:12Z). `ledgerAccountOf` now matches the login to the declared `github-apps` role whose name the slug ends in (the declaration holds no slug), and a `[bot]` login no declared role owns reads `UNREADABLE`. `ledgerSpender` read ONE file, `$GH_CONFIG_DIR/gh-calls.tsv`; it now reads the workers', leads' and reviewer's ledgers too (`ledgerPathsOf`), each distinct file once, and says "no graphql point is recorded" only when every one of them was read. a11ign/a11ign#4916, follow-up of #4148.
