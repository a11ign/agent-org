---
"@a11ign/agent-org": patch
---

The three GitHub Apps (`a11ign-scheduler`, `a11ign-workers`, `a11ign-managers`) are named among the org's own logins, in the three spellings GitHub gives an App's author (`<slug>[bot]` in REST, `<slug>` for a GraphQL `Bot`, `app/<slug>` in `gh pr list`) (a11ign/agent-org#797). Before, `classifyLogin` read an App's commit or pull request as a person's, so it counted as a hand fix in the ledger, and `readFixRow` reported a row an App had commented on as having no org comment. The ledger and the fix-row reader now share one list, `ORG_LOGINS` in `src/messaging/sources/readers.ts`, which `hand-fix-ledger.ts` imports and no longer restates, so a login added there is read by both.
