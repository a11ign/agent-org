---
"@a11ign/agent-org": patch
---

In `webhook` mode the gate reads only the pull requests the tick's scopes name and records when each dated wait comes due (a11ign/a11ign#5043, agent-org#1093). `readPrs` on the checkout's own repository keeps the open list it last read whole, re-reads (with `gh pr view`, through the ticket port's `pullViewArgs`) only the pull requests `A11Y_TICK_SCOPES_FILE` names, and patches them in; no remembered list, a list older than the reconcile, a `sha` or merge-group scope or a failed view reads whole as before, and an empty list is never remembered. `readOpenRows` writes each repository's `Not-before:`, `Fleet-hold-until:` and aged-backlog instants to the due-index (`src/work-gate/due-index-write.ts`), never from an empty list or one at the row cap. `poll` mode (no scopes file, no `webhook` declaration) makes today's calls and writes nothing; the revert is `"source": "poll"` in `host.json`.
